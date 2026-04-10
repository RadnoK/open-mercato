import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { JobService } from '../../../lib/job-service'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['item_processing.view'] },
}

export const openApi = {
  tags: ['ItemProcessing'],
  summary: 'Get processing job detail',
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const container = await createRequestContainer()
  const jobService = container.resolve('itemProcessingJobService') as JobService

  const job = await jobService.getJob(id, { organizationId: auth.orgId, tenantId: auth.tenantId })
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  return NextResponse.json(job)
}
