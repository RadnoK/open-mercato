import type { EntityManager } from '@mikro-orm/postgresql'
import type { ProgressService } from '../../progress/lib/progressService'
import { ProcessingItem } from '../data/entities'
import { emitItemProcessingEvent } from '../events'
import type { TenantScope, PipelineStepDefinition, StepProviderInput } from './types'
import type { JobService } from './job-service'
import { getStepProvider } from './provider-registry'
import { evaluateCondition } from './condition-evaluator'
import { resolveDeep, sleep } from './utils'

// ─── Types ──────────────────────────────────────────────────────────────────

type EngineDeps = {
  em: EntityManager
  jobService: JobService
  progressService: ProgressService
  agentReviewer?: AgentReviewer
}

interface AgentReviewer {
  processStep(
    jobId: string,
    step: PipelineStepDefinition,
    items: ProcessingItem[],
    scope: TenantScope,
  ): Promise<{ totalReviewed: number; autoApproved: number; escalated: number; hasEscalated: boolean }>
}

interface RunContext {
  jobId: string
  scope: TenantScope
  progressJobId: string | null
}

// ─── Engine ─────────────────────────────────────────────────────────────────

export function createProcessingEngine(deps: EngineDeps) {
  const { em: rootEm, jobService, progressService } = deps

  // ── helpers ──

  function getEm(): EntityManager {
    return rootEm.fork()
  }

  async function checkCancellation(ctx: RunContext): Promise<boolean> {
    if (!ctx.progressJobId) return false
    return progressService.isCancellationRequested(ctx.progressJobId)
  }

  async function finalizeJob(
    ctx: RunContext,
    status: 'completed' | 'failed' | 'cancelled',
    error?: string,
  ): Promise<void> {
    const localEm = getEm()
    const items = await localEm.find(ProcessingItem, { jobId: ctx.jobId })

    const completed = items.filter((i) => i.status === 'completed').length
    const failed = items.filter((i) => i.status === 'failed').length
    const skipped = items.filter((i) => i.status === 'skipped').length
    const awaitingReview = items.filter((i) => i.status === 'awaiting_review').length

    await jobService.updateStatus(ctx.jobId, status, ctx.scope, error)
    await localEm.nativeUpdate(
      (await import('../data/entities')).ProcessingJob,
      { id: ctx.jobId },
      {
        resultSummary: { completed, failed, skipped, awaitingReview, total: items.length, error: error ?? null },
        completedAt: new Date(),
      },
    )

    if (ctx.progressJobId) {
      const progressScope = { tenantId: ctx.scope.tenantId, organizationId: ctx.scope.organizationId, userId: ctx.scope.userId }
      if (status === 'completed') {
        await progressService.completeJob(ctx.progressJobId, {
          resultSummary: { completed, failed, skipped },
        }, progressScope)
      } else if (status === 'failed') {
        await progressService.failJob(ctx.progressJobId, {
          errorMessage: error ?? 'Processing failed',
        }, progressScope)
      } else if (status === 'cancelled') {
        await progressService.markCancelled(ctx.progressJobId, progressScope)
      }
    }

    const eventId = status === 'completed'
      ? 'item_processing.job.completed' as const
      : status === 'failed'
        ? 'item_processing.job.failed' as const
        : 'item_processing.job.completed' as const

    await emitItemProcessingEvent(eventId, {
      jobId: ctx.jobId,
      tenantId: ctx.scope.tenantId,
      organizationId: ctx.scope.organizationId,
    })
  }

  function buildItemData(
    item: ProcessingItem,
    step: PipelineStepDefinition,
  ): Record<string, unknown> {
    const base = { ...(item.inputData ?? {}), ...(item.outputData ?? {}) }

    if (!step.inputMapping) return base

    const mapped: Record<string, unknown> = { ...base }
    for (const [targetKey, sourceKey] of Object.entries(step.inputMapping)) {
      mapped[targetKey] = resolveDeep(base, sourceKey)
    }
    return mapped
  }

  function applyOutputMapping(
    item: ProcessingItem,
    step: PipelineStepDefinition,
    resultData: Record<string, unknown> | undefined,
  ): void {
    if (!resultData) return

    const currentOutput = item.outputData ?? {}

    if (!step.outputMapping) {
      item.outputData = { ...currentOutput, ...resultData }
      return
    }

    const mapped: Record<string, unknown> = { ...currentOutput }
    for (const [targetKey, sourceKey] of Object.entries(step.outputMapping)) {
      mapped[targetKey] = resolveDeep(resultData, sourceKey)
    }
    item.outputData = mapped
  }

  // ── main ──

  async function runJob(jobId: string, scope: TenantScope): Promise<void> {
    const job = await jobService.getJob(jobId, scope)
    if (!job) {
      console.warn(`[item-processing] Job ${jobId} not found, skipping`)
      return
    }
    if (job.status !== 'pending' && job.status !== 'running') {
      console.warn(`[item-processing] Job ${jobId} has status ${job.status}, cannot run`)
      return
    }

    const steps = job.config as PipelineStepDefinition[]
    if (!steps || steps.length === 0) {
      await jobService.updateStatus(jobId, 'completed', scope)
      return
    }

    // Mark running
    if (job.status === 'pending') {
      await jobService.updateStatus(jobId, 'running', scope)
    }

    // Create progress job if not exists
    let progressJobId = job.progressJobId ?? null
    if (!progressJobId) {
      const progressScope = { tenantId: scope.tenantId, organizationId: scope.organizationId, userId: scope.userId }
      const progressJob = await progressService.createJob(
        { jobType: 'item-processing', name: `Processing: ${job.name ?? jobId}`, totalCount: job.totalItems, cancellable: true },
        progressScope,
      )
      progressJobId = progressJob.id
      await getEm().nativeUpdate(
        (await import('../data/entities')).ProcessingJob,
        { id: jobId },
        { progressJobId },
      )
      await progressService.startJob(progressJobId, progressScope)
    }

    await emitItemProcessingEvent('item_processing.job.started', {
      jobId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    })

    const ctx: RunContext = { jobId, scope, progressJobId }

    // Find start step index
    let startIndex = 0
    if (job.currentStep) {
      const idx = steps.findIndex((s) => s.stepKey === job.currentStep)
      if (idx >= 0) startIndex = idx
    }

    await executeSteps(ctx, steps, startIndex)
  }

  async function executeSteps(ctx: RunContext, steps: PipelineStepDefinition[], startIndex: number): Promise<void> {
    for (let i = startIndex; i < steps.length; i++) {
      const step = steps[i]
      await jobService.setCurrentStep(ctx.jobId, step.stepKey, ctx.scope)

      // Check cancellation
      if (await checkCancellation(ctx)) {
        await finalizeJob(ctx, 'cancelled')
        return
      }

      // ── REVIEW step ──
      if (step.type === 'review') {
        await handleReviewStep(ctx, step)
        return // STOP — wait for human
      }

      // ── AGENT_REVIEW step ──
      if (step.type === 'agent_review') {
        const shouldPause = await handleAgentReviewStep(ctx, step)
        if (shouldPause) return // STOP — some items escalated to human
        continue // all auto-approved, next step
      }

      // ── AUTOMATED step ──
      if (step.type === 'automated') {
        await handleAutomatedStep(ctx, step)
        continue
      }
    }

    // All steps done — finalize
    const localEm = getEm()
    await localEm.nativeUpdate(
      ProcessingItem,
      { jobId: ctx.jobId, status: { $nin: ['failed', 'skipped'] } },
      { status: 'completed' },
    )
    await finalizeJob(ctx, 'completed')
  }

  async function handleReviewStep(ctx: RunContext, step: PipelineStepDefinition): Promise<void> {
    const localEm = getEm()
    await localEm.nativeUpdate(
      ProcessingItem,
      { jobId: ctx.jobId, status: { $nin: ['failed', 'skipped'] } },
      { status: 'awaiting_review', currentStep: step.stepKey },
    )

    await jobService.updateStatus(ctx.jobId, 'paused', ctx.scope)
    await emitItemProcessingEvent('item_processing.job.paused_for_review', {
      jobId: ctx.jobId,
      stepKey: step.stepKey,
      tenantId: ctx.scope.tenantId,
      organizationId: ctx.scope.organizationId,
    })
  }

  async function handleAgentReviewStep(ctx: RunContext, step: PipelineStepDefinition): Promise<boolean> {
    if (!deps.agentReviewer) {
      throw new Error(`Agent reviewer not configured. Cannot process agent_review step "${step.stepKey}".`)
    }

    const localEm = getEm()
    const items = await localEm.find(ProcessingItem, {
      jobId: ctx.jobId,
      status: { $nin: ['failed', 'skipped'] },
    })

    const result = await deps.agentReviewer.processStep(ctx.jobId, step, items, ctx.scope)

    await emitItemProcessingEvent('item_processing.job.step_completed', {
      jobId: ctx.jobId,
      stepKey: step.stepKey,
      autoApproved: result.autoApproved,
      escalated: result.escalated,
      tenantId: ctx.scope.tenantId,
      organizationId: ctx.scope.organizationId,
    })

    if (result.hasEscalated) {
      await jobService.updateStatus(ctx.jobId, 'paused', ctx.scope)
      await emitItemProcessingEvent('item_processing.job.paused_for_review', {
        jobId: ctx.jobId,
        stepKey: step.stepKey,
        tenantId: ctx.scope.tenantId,
        organizationId: ctx.scope.organizationId,
      })
      return true // pause
    }

    return false // continue
  }

  async function handleAutomatedStep(ctx: RunContext, step: PipelineStepDefinition): Promise<void> {
    const provider = getStepProvider(step.providerKey!)
    if (!provider) {
      if (step.optional) {
        console.warn(`[item-processing] Provider "${step.providerKey}" not found, skipping optional step "${step.stepKey}"`)
        return
      }
      await finalizeJob(ctx, 'failed', `Provider "${step.providerKey}" not registered`)
      return
    }

    const localEm = getEm()
    const chunkSize = 100
    let offset = 0
    let hasMore = true

    while (hasMore) {
      const items = await localEm.find(
        ProcessingItem,
        { jobId: ctx.jobId, status: { $nin: ['failed', 'skipped'] } },
        { orderBy: { itemIndex: 'ASC' }, limit: chunkSize, offset },
      )

      if (items.length < chunkSize) hasMore = false
      offset += items.length

      for (const item of items) {
        // Check cancellation periodically
        if (await checkCancellation(ctx)) {
          await finalizeJob(ctx, 'cancelled')
          return
        }

        // Evaluate condition
        if (step.condition) {
          const shouldRun = evaluateCondition(step.condition, (item.stepResults ?? {}) as Record<string, unknown>)
          if (!shouldRun) {
            const stepResults = { ...(item.stepResults ?? {}), [step.stepKey]: { status: 'skipped' } }
            await localEm.nativeUpdate(ProcessingItem, { id: item.id }, { stepResults })
            await jobService.updateCounters(ctx.jobId, { skipped: 1 }, ctx.scope)
            continue
          }
        }

        // Build item data with mapping
        const itemData = buildItemData(item, step)

        // Call provider with retry
        const maxRetries = step.retryPolicy?.maxRetries ?? 0
        const backoffMs = step.retryPolicy?.backoffMs ?? 1000
        let lastError: string | null = null
        let success = false

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const providerInput: StepProviderInput = {
              itemId: item.id,
              itemIndex: item.itemIndex,
              itemData,
              stepConfig: step.providerConfig ?? {},
              scope: ctx.scope,
            }

            const result = await provider.processItem(providerInput)

            // Save step result
            const stepResults = { ...(item.stepResults ?? {}), [step.stepKey]: result }
            const updates: Record<string, unknown> = { stepResults }

            // Apply output mapping
            if (result.data) {
              const currentOutput = item.outputData ?? {}
              if (step.outputMapping) {
                const mapped: Record<string, unknown> = { ...currentOutput }
                for (const [targetKey, sourceKey] of Object.entries(step.outputMapping)) {
                  mapped[targetKey] = resolveDeep(result.data, sourceKey)
                }
                updates.outputData = mapped
              } else {
                updates.outputData = { ...currentOutput, ...result.data }
              }
            }

            // Handle error result
            if (result.status === 'error' && !step.optional) {
              updates.status = 'failed'
              updates.errorMessage = result.error ?? 'Step returned error'
              await localEm.nativeUpdate(ProcessingItem, { id: item.id }, updates)
              await jobService.updateCounters(ctx.jobId, { failed: 1 }, ctx.scope)
            } else {
              updates.currentStep = step.stepKey
              await localEm.nativeUpdate(ProcessingItem, { id: item.id }, updates)
              await jobService.updateCounters(ctx.jobId, { processed: 1 }, ctx.scope)
            }

            // Update progress
            if (ctx.progressJobId) {
              await progressService.incrementProgress(ctx.progressJobId, 1, {
                tenantId: ctx.scope.tenantId,
                organizationId: ctx.scope.organizationId,
                userId: ctx.scope.userId,
              })
            }

            success = true
            break
          } catch (err) {
            lastError = err instanceof Error ? err.message : 'Provider execution failed'
            if (attempt < maxRetries) {
              await sleep(backoffMs * (attempt + 1))
            }
          }
        }

        if (!success) {
          if (step.optional) {
            const stepResults = { ...(item.stepResults ?? {}), [step.stepKey]: { status: 'error', error: lastError } }
            await localEm.nativeUpdate(ProcessingItem, { id: item.id }, { stepResults })
          } else {
            await localEm.nativeUpdate(ProcessingItem, { id: item.id }, {
              status: 'failed',
              errorMessage: lastError,
              stepResults: { ...(item.stepResults ?? {}), [step.stepKey]: { status: 'error', error: lastError } },
            })
            await jobService.updateCounters(ctx.jobId, { failed: 1 }, ctx.scope)
          }
        }
      }
    }

    await emitItemProcessingEvent('item_processing.job.step_completed', {
      jobId: ctx.jobId,
      stepKey: step.stepKey,
      tenantId: ctx.scope.tenantId,
      organizationId: ctx.scope.organizationId,
    })
  }

  // ── resume / retry ──

  async function resumeAfterReview(jobId: string, scope: TenantScope): Promise<void> {
    const job = await jobService.getJob(jobId, scope)
    if (!job) throw new Error(`Job ${jobId} not found`)
    if (job.status !== 'paused') throw new Error(`Job ${jobId} is not paused (status: ${job.status})`)

    const steps = job.config as PipelineStepDefinition[]
    if (!steps) throw new Error(`Job ${jobId} has no pipeline config`)

    const currentIndex = steps.findIndex((s) => s.stepKey === job.currentStep)
    if (currentIndex < 0) throw new Error(`Current step "${job.currentStep}" not found in pipeline config`)

    // Move awaiting_review items back to processable state
    const localEm = getEm()
    await localEm.nativeUpdate(
      ProcessingItem,
      { jobId, status: 'awaiting_review' },
      { status: 'pending' },
    )

    await jobService.updateStatus(jobId, 'running', scope)

    const ctx: RunContext = { jobId, scope, progressJobId: job.progressJobId ?? null }
    await executeSteps(ctx, steps, currentIndex + 1)
  }

  async function retryFailedItems(jobId: string, scope: TenantScope): Promise<void> {
    const job = await jobService.getJob(jobId, scope)
    if (!job) throw new Error(`Job ${jobId} not found`)

    if (job.failedItems === 0) throw new Error(`Job ${jobId} has no failed items to retry`)

    // Reset failed items
    const localEm = getEm()
    await localEm.nativeUpdate(
      ProcessingItem,
      { jobId, status: 'failed' },
      { status: 'pending', errorMessage: null, currentStep: null },
    )

    // Reset job counters
    await localEm.nativeUpdate(
      (await import('../data/entities')).ProcessingJob,
      { id: jobId },
      { failedItems: 0, status: 'pending' },
    )
  }

  return {
    runJob,
    resumeAfterReview,
    retryFailedItems,
  }
}

export type ProcessingEngine = ReturnType<typeof createProcessingEngine>
