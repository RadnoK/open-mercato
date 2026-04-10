import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { JobService } from '../../../../lib/job-service'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['item_processing.view'] },
}

export const openApi = {
  tags: ['ItemProcessing'],
  summary: 'List items for a processing job',
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const url = new URL(req.url)
  const status = url.searchParams.get('status') || undefined
  const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10)
  const pageSize = Number.parseInt(url.searchParams.get('pageSize') ?? '100', 10)

  const container = await createRequestContainer()
  const jobService = container.resolve('itemProcessingJobService') as JobService
  const scope = { organizationId: auth.orgId, tenantId: auth.tenantId }

  const result = await jobService.getJobItems(id, scope, { status: status as any, page, pageSize })

  return NextResponse.json({ items: result.items, total: result.total, page, pageSize })
}
