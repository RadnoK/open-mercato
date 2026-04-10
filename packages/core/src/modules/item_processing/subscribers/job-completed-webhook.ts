import type { EntityManager } from '@mikro-orm/postgresql'
import { ProcessingJob, ProcessingItem, ProcessingPipeline } from '../data/entities'

export const metadata = {
  event: 'item_processing.job.completed',
  persistent: true,
  id: 'item-processing:job-completed-webhook',
}

type Payload = {
  jobId: string
  tenantId: string
  organizationId: string
}

type ResolverContext = {
  resolve: <T = unknown>(name: string) => T
}

export default async function handler(payload: Payload, ctx: ResolverContext): Promise<void> {
  const em = ctx.resolve<EntityManager>('em').fork()

  const job = await em.findOne(ProcessingJob, {
    id: payload.jobId,
    tenantId: payload.tenantId,
    deletedAt: null,
  })
  if (!job) return

  const pipeline = await em.findOne(ProcessingPipeline, {
    id: job.pipelineId,
    deletedAt: null,
  })
  if (!pipeline?.webhookUrl) return

  const items = await em.find(ProcessingItem, { jobId: job.id }, {
    orderBy: { itemIndex: 'ASC' },
  })

  try {
    await fetch(pipeline.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'item_processing.job.completed',
        jobId: job.id,
        pipelineKey: pipeline.pipelineKey,
        resultSummary: job.resultSummary,
        items: items.map((i) => ({
          id: i.id,
          itemIndex: i.itemIndex,
          inputData: i.inputData,
          outputData: i.outputData,
          selectedValues: i.selectedValues,
          status: i.status,
        })),
      }),
      signal: AbortSignal.timeout(10000),
    })
  } catch (err) {
    console.warn('[item-processing] Webhook delivery failed:', err instanceof Error ? err.message : err)
  }
}
