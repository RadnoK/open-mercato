import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { JobService } from '../../../../lib/job-service'
import { getItemProcessingQueue } from '../../../../lib/queue'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['item_processing.run'] },
}

export const openApi = {
  tags: ['ItemProcessing'],
  summary: 'Start a pending processing job',
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const container = await createRequestContainer()
  const jobService = container.resolve('itemProcessingJobService') as JobService
  const scope = { organizationId: auth.orgId, tenantId: auth.tenantId, userId: auth.sub }

  const job = await jobService.getJob(id, scope)
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }
  if (job.status !== 'pending') {
    return NextResponse.json({ error: `Job status is "${job.status}", expected "pending"` }, { status: 409 })
  }

  const queue = getItemProcessingQueue()
  await queue.enqueue({
    jobId: job.id,
    action: 'run',
    scope: { organizationId: scope.organizationId, tenantId: scope.tenantId, userId: scope.userId },
  })

  return NextResponse.json({ id: job.id, status: 'pending' }, { status: 202 })
}
