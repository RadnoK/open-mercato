import type { EntityManager } from '@mikro-orm/postgresql'
import { ProcessingJob, ProcessingItem } from '../data/entities'
import type { AnomalyDetector } from '../lib/anomaly-detector'

export const metadata = {
  event: 'item_processing.job.completed',
  persistent: true,
  id: 'item-processing:anomaly-detection',
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

  const items = await em.find(ProcessingItem, {
    jobId: payload.jobId,
    tenantId: payload.tenantId,
  }, { orderBy: { itemIndex: 'ASC' } })

  if (items.length < 3) return

  try {
    const detector = ctx.resolve<AnomalyDetector>('itemProcessingAnomalyDetector')
    const report = await detector.analyzeJob(payload.jobId, items, {
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
    })

    if (report.anomalies.length > 0) {
      const job = await em.findOne(ProcessingJob, { id: payload.jobId })
      if (job) {
        const currentSummary = (job.resultSummary ?? {}) as Record<string, unknown>
        await em.nativeUpdate(ProcessingJob, { id: payload.jobId }, {
          resultSummary: { ...currentSummary, anomalies: report },
        })
      }
    }
  } catch (err) {
    console.warn('[item-processing] Anomaly detection subscriber failed:', err instanceof Error ? err.message : err)
  }
}
