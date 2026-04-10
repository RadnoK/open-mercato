import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ProcessingJob, ProcessingItem, ProcessingPipeline } from './data/entities'
import { getAllStepProviders } from './lib/provider-registry'
import { getItemProcessingQueue } from './lib/queue'
import type { PipelineDesigner } from './lib/pipeline-designer'
import type { JobService } from './lib/job-service'

type ToolContext = {
  tenantId: string | null
  organizationId: string | null
  userId: string | null
  container: any
  userFeatures: string[]
}

function requireScope(ctx: ToolContext) {
  if (!ctx.tenantId || !ctx.organizationId) throw new Error('Tenant context required')
  return { tenantId: ctx.tenantId, organizationId: ctx.organizationId, userId: ctx.userId }
}

export const aiTools = [
  {
    name: 'item_processing_create_job',
    description: 'Create a new item processing job. Provide a pipeline key and array of items. Returns the job ID. If autoStart is true (default), processing begins immediately. Use item_processing_get_job to check progress.',
    inputSchema: z.object({
      pipelineKey: z.string().describe('Pipeline configuration key (e.g. "customs_hs_classification")'),
      items: z.array(z.record(z.string(), z.unknown())).min(1).describe('Array of items to process'),
      name: z.string().optional().describe('Optional human-readable job name'),
      autoStart: z.boolean().optional().default(true).describe('Start processing immediately'),
    }),
    requiredFeatures: ['item_processing.run'],
    handler: async (input: any, ctx: ToolContext) => {
      const scope = requireScope(ctx)
      const em = ctx.container.resolve('em').fork() as EntityManager

      const pipeline = await em.findOne(ProcessingPipeline, {
        pipelineKey: input.pipelineKey,
        tenantId: scope.tenantId,
        isActive: true,
        deletedAt: null,
      })
      if (!pipeline) return { error: `Pipeline "${input.pipelineKey}" not found` }

      const jobService = ctx.container.resolve('itemProcessingJobService') as JobService
      const job = await jobService.createJob({
        pipelineId: pipeline.id,
        name: input.name,
        items: input.items,
        config: pipeline.steps,
        sourceType: 'api',
      }, scope)

      if (input.autoStart) {
        const queue = getItemProcessingQueue()
        await queue.enqueue({
          jobId: job.id,
          action: 'run',
          scope: { organizationId: scope.organizationId, tenantId: scope.tenantId, userId: scope.userId },
        })
      }

      return { jobId: job.id, status: job.status, totalItems: job.totalItems, pipelineKey: input.pipelineKey }
    },
  },
  {
    name: 'item_processing_get_job',
    description: 'Get the status and items of a processing job. Returns job status, current step, progress counters, and optionally all items with their step results, suggestions, and agent decisions.',
    inputSchema: z.object({
      jobId: z.string().uuid().describe('Processing job ID'),
      includeItems: z.boolean().optional().default(true).describe('Include item details'),
      itemLimit: z.number().optional().default(50).describe('Max items to return'),
    }),
    requiredFeatures: ['item_processing.view'],
    handler: async (input: any, ctx: ToolContext) => {
      const scope = requireScope(ctx)
      const em = ctx.container.resolve('em').fork() as EntityManager

      const job = await em.findOne(ProcessingJob, { id: input.jobId, tenantId: scope.tenantId, deletedAt: null })
      if (!job) return { error: 'Job not found' }

      const result: Record<string, unknown> = {
        id: job.id,
        name: job.name,
        status: job.status,
        currentStep: job.currentStep,
        totalItems: job.totalItems,
        processedItems: job.processedItems,
        failedItems: job.failedItems,
        skippedItems: job.skippedItems,
        resultSummary: job.resultSummary,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        createdAt: job.createdAt,
      }

      if (input.includeItems) {
        const items = await em.find(ProcessingItem, { jobId: job.id }, {
          orderBy: { itemIndex: 'ASC' },
          limit: input.itemLimit,
        })
        result.items = items.map((i) => ({
          id: i.id,
          index: i.itemIndex,
          status: i.status,
          currentStep: i.currentStep,
          inputData: i.inputData,
          outputData: i.outputData,
          stepResults: i.stepResults,
          selectedValues: i.selectedValues,
          errorMessage: i.errorMessage,
        }))
      }

      return result
    },
  },
  {
    name: 'item_processing_submit_review',
    description: 'Submit review selections for items that are awaiting review. Each selection maps an item ID to a chosen value. Automatically resumes the job after submission.',
    inputSchema: z.object({
      jobId: z.string().uuid().describe('Processing job ID'),
      selections: z.array(z.object({
        itemId: z.string().uuid().describe('Item ID'),
        selectedValue: z.record(z.string(), z.unknown()).describe('Selected value (e.g. { hsCode: "8471.30" })'),
      })).min(1).describe('Review selections'),
    }),
    requiredFeatures: ['item_processing.review'],
    handler: async (input: any, ctx: ToolContext) => {
      const scope = requireScope(ctx)
      const em = ctx.container.resolve('em').fork() as EntityManager

      for (const selection of input.selections) {
        const item = await em.findOne(ProcessingItem, { id: selection.itemId, jobId: input.jobId, tenantId: scope.tenantId })
        if (!item) continue

        const currentStep = item.currentStep ?? 'review'
        const selectedValues = { ...(item.selectedValues ?? {}), [currentStep]: selection.selectedValue }
        await em.nativeUpdate(ProcessingItem, { id: selection.itemId }, { selectedValues })
      }

      const queue = getItemProcessingQueue()
      await queue.enqueue({
        jobId: input.jobId,
        action: 'resume',
        scope: { organizationId: scope.organizationId, tenantId: scope.tenantId, userId: scope.userId },
      })

      return { submitted: input.selections.length, resumed: true }
    },
  },
  {
    name: 'item_processing_list_pipelines',
    description: 'List all available processing pipelines with their step definitions. Use this to discover what pipelines are configured before creating a job.',
    inputSchema: z.object({}),
    requiredFeatures: ['item_processing.view'],
    handler: async (_input: any, ctx: ToolContext) => {
      const scope = requireScope(ctx)
      const em = ctx.container.resolve('em').fork() as EntityManager

      const pipelines = await em.find(ProcessingPipeline, {
        tenantId: scope.tenantId,
        isActive: true,
        deletedAt: null,
      })

      return {
        pipelines: pipelines.map((p) => ({
          key: p.pipelineKey,
          name: p.name,
          description: p.description,
          stepsCount: p.steps?.length ?? 0,
          steps: p.steps?.map((s: any) => ({ stepKey: s.stepKey, type: s.type, providerKey: s.providerKey, label: s.label })),
        })),
      }
    },
  },
  {
    name: 'item_processing_list_providers',
    description: 'List all registered step providers with their capabilities. Providers are the building blocks of pipeline steps.',
    inputSchema: z.object({}),
    requiredFeatures: ['item_processing.view'],
    handler: async () => {
      const providers = getAllStepProviders()
      return {
        providers: providers.map((p) => ({
          key: p.providerKey,
          name: p.displayName,
          category: p.category,
          description: p.description ?? null,
        })),
      }
    },
  },
  {
    name: 'item_processing_design_pipeline',
    description: 'Design a processing pipeline from a natural language description. Analyzes available providers and creates an optimal step configuration. Returns a pipeline definition ready to be created via the pipelines API.',
    inputSchema: z.object({
      description: z.string().describe('What needs to be processed and how (e.g. "Classify Chinese product descriptions into HS codes")'),
      itemSample: z.record(z.string(), z.unknown()).optional().describe('Example item for context'),
      includeAgentReview: z.boolean().optional().default(true).describe('Include AI agent review step'),
      includeHumanReview: z.boolean().optional().default(true).describe('Include human review step'),
    }),
    requiredFeatures: ['item_processing.configure'],
    handler: async (input: any, ctx: ToolContext) => {
      const designer = ctx.container.resolve('itemProcessingPipelineDesigner') as PipelineDesigner
      const providers = getAllStepProviders()

      const result = await designer.designPipeline({
        description: input.description,
        itemSample: input.itemSample,
        availableProviders: providers,
        preferences: {
          includeAgentReview: input.includeAgentReview,
          includeHumanReview: input.includeHumanReview,
          maxStepCount: 10,
        },
      })

      return result
    },
  },
]
