import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import type { ProgressService } from '../../progress/lib/progressService'
import type { ProcessingEngine } from '../lib/processing-engine'
import type { JobService } from '../lib/job-service'

type RunJobPayload = {
  jobId: string
  action: 'run' | 'resume' | 'retry'
  scope: {
    organizationId: string
    tenantId: string
    userId?: string | null
  }
}

export const metadata: WorkerMeta = {
  queue: 'item-processing-run',
  id: 'item-processing:run-job',
  concurrency: 5,
}

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

export default async function handle(job: QueuedJob<RunJobPayload>, ctx: HandlerContext): Promise<void> {
  const { jobId, action, scope } = job.payload

  try {
    const engine = ctx.resolve<ProcessingEngine>('itemProcessingEngine')

    if (action === 'run') {
      await engine.runJob(jobId, scope)
    } else if (action === 'resume') {
      await engine.resumeAfterReview(jobId, scope)
    } else if (action === 'retry') {
      await engine.retryFailedItems(jobId, scope)
      await engine.runJob(jobId, scope)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Item processing worker failed'
    const errorStack = error instanceof Error ? error.stack : undefined

    try {
      const jobService = ctx.resolve<JobService>('itemProcessingJobService')
      const progressService = ctx.resolve<ProgressService>('progressService')
      const run = await jobService.getJob(jobId, scope)

      if (run && run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') {
        await jobService.updateStatus(jobId, 'failed', scope, message)
        if (run.progressJobId) {
          await progressService.failJob(
            run.progressJobId,
            { errorMessage: message, errorStack },
            scope,
          )
        }
      }
    } catch (finalizeError) {
      console.error('[item-processing] Failed to finalize crashed worker job:', finalizeError)
    }

    throw error
  }
}
