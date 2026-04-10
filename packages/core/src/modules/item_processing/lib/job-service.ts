import type { EntityManager } from '@mikro-orm/postgresql'
import { ProcessingJob, ProcessingItem } from '../data/entities'
import type { TenantScope, JobStatus, ItemStatus, PipelineStepDefinition } from './types'

// ─── Status Transitions ─────────────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<string, JobStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['paused', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  failed: ['pending'],
  completed: [],
  cancelled: [],
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface CounterDelta {
  processed?: number
  failed?: number
  skipped?: number
}

interface ListFilters {
  status?: JobStatus
  pipelineId?: string
  page?: number
  pageSize?: number
}

interface ItemFilters {
  status?: ItemStatus
  page?: number
  pageSize?: number
}

// ─── Service ────────────────────────────────────────────────────────────────

export function createJobService(em: EntityManager) {
  async function createJob(
    input: {
      pipelineId: string
      name?: string
      items: Record<string, unknown>[]
      config: PipelineStepDefinition[]
      sourceType?: string
      sourceId?: string
    },
    scope: TenantScope,
  ): Promise<ProcessingJob> {
    const job = em.create(ProcessingJob, {
      pipelineId: input.pipelineId,
      name: input.name ?? null,
      status: 'pending',
      totalItems: input.items.length,
      config: input.config,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      createdBy: scope.userId ?? null,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
    })
    em.persist(job)
    await em.flush()

    const batchSize = 500
    for (let i = 0; i < input.items.length; i += batchSize) {
      const batch = input.items.slice(i, i + batchSize)
      for (let j = 0; j < batch.length; j++) {
        const item = em.create(ProcessingItem, {
          jobId: job.id,
          itemIndex: i + j,
          status: 'pending',
          inputData: batch[j],
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
        })
        em.persist(item)
      }
      await em.flush()
    }

    return job
  }

  async function getJob(jobId: string, scope: TenantScope): Promise<ProcessingJob | null> {
    return em.findOne(ProcessingJob, {
      id: jobId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    })
  }

  async function listJobs(filters: ListFilters, scope: TenantScope): Promise<{ items: ProcessingJob[]; total: number }> {
    const where: Record<string, unknown> = {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    }
    if (filters.status) where.status = filters.status
    if (filters.pipelineId) where.pipelineId = filters.pipelineId

    const page = filters.page ?? 1
    const pageSize = Math.min(filters.pageSize ?? 50, 100)

    const [items, total] = await em.findAndCount(ProcessingJob, where, {
      orderBy: { createdAt: 'DESC' },
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })

    return { items, total }
  }

  async function updateStatus(
    jobId: string,
    newStatus: JobStatus,
    scope: TenantScope,
    error?: string,
  ): Promise<ProcessingJob | null> {
    const job = await getJob(jobId, scope)
    if (!job) return null

    const allowed = ALLOWED_TRANSITIONS[job.status]
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(`Invalid status transition: ${job.status} → ${newStatus}`)
    }

    const affectedRows = await em.nativeUpdate(
      ProcessingJob,
      { id: jobId, status: job.status },
      {
        status: newStatus,
        ...(newStatus === 'running' && !job.startedAt ? { startedAt: new Date() } : {}),
        ...(newStatus === 'completed' || newStatus === 'failed' || newStatus === 'cancelled'
          ? { completedAt: new Date() }
          : {}),
        ...(error ? { resultSummary: { ...(job.resultSummary ?? {}), error } } : {}),
      },
    )

    if (affectedRows === 0) {
      throw new Error(`Stale status update: job ${jobId} was modified concurrently`)
    }

    return em.findOne(ProcessingJob, { id: jobId })
  }

  async function updateCounters(jobId: string, delta: CounterDelta, scope: TenantScope): Promise<void> {
    const updates: Record<string, unknown> = {}
    if (delta.processed) updates.processedItems = em.raw(`processed_items + ${delta.processed}`)
    if (delta.failed) updates.failedItems = em.raw(`failed_items + ${delta.failed}`)
    if (delta.skipped) updates.skippedItems = em.raw(`skipped_items + ${delta.skipped}`)

    if (Object.keys(updates).length > 0) {
      await em.nativeUpdate(ProcessingJob, { id: jobId }, updates)
    }
  }

  async function setCurrentStep(jobId: string, stepKey: string | null, scope: TenantScope): Promise<void> {
    await em.nativeUpdate(ProcessingJob, { id: jobId }, { currentStep: stepKey })
  }

  async function getJobItems(jobId: string, scope: TenantScope, filters?: ItemFilters): Promise<{ items: ProcessingItem[]; total: number }> {
    const where: Record<string, unknown> = {
      jobId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    }
    if (filters?.status) where.status = filters.status

    const page = filters?.page ?? 1
    const pageSize = Math.min(filters?.pageSize ?? 100, 100)

    const [items, total] = await em.findAndCount(ProcessingItem, where, {
      orderBy: { itemIndex: 'ASC' },
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })

    return { items, total }
  }

  async function updateItem(
    itemId: string,
    updates: Partial<Pick<ProcessingItem, 'status' | 'currentStep' | 'outputData' | 'stepResults' | 'selectedValues' | 'errorMessage'>>,
    scope: TenantScope,
  ): Promise<void> {
    await em.nativeUpdate(
      ProcessingItem,
      { id: itemId, tenantId: scope.tenantId },
      updates,
    )
  }

  async function updateItemsBulk(
    jobId: string,
    updates: Array<{ itemId: string; changes: Record<string, unknown> }>,
    scope: TenantScope,
  ): Promise<void> {
    for (const { itemId, changes } of updates) {
      await em.nativeUpdate(
        ProcessingItem,
        { id: itemId, jobId, tenantId: scope.tenantId },
        changes,
      )
    }
  }

  return {
    createJob,
    getJob,
    listJobs,
    updateStatus,
    updateCounters,
    setCurrentStep,
    getJobItems,
    updateItem,
    updateItemsBulk,
  }
}

export type JobService = ReturnType<typeof createJobService>
