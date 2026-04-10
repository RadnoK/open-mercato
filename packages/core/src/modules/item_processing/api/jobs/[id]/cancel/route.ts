import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { JobService } from '../../../../lib/job-service'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['item_processing.run'] },
}

export const openApi = {
  tags: ['ItemProcessing'],
  summary: 'Cancel a processing job',
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const container = await createRequestContainer()
  const jobService = container.resolve('itemProcessingJobService') as JobService
  const progressService = container.resolve('progressService') as { cancelJob: (jobId: string, scope: Record<string, unknown>) => Promise<unknown> }
  const scope = { organizationId: auth.orgId, tenantId: auth.tenantId, userId: auth.sub }

  const job = await jobService.getJob(id, scope)
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  if (job.status === 'completed' || job.status === 'cancelled') {
    return NextResponse.json({ error: `Job is already "${job.status}"` }, { status: 409 })
  }

  if (job.status === 'running' && job.progressJobId) {
    await progressService.cancelJob(job.progressJobId, scope)
  } else {
    await jobService.updateStatus(id, 'cancelled', scope)
  }

  return NextResponse.json({ id: job.id, status: 'cancelled' })
}
