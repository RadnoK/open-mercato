import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { JobService } from '../../lib/job-service'
import type { PipelineService } from '../../lib/pipeline-service'
import { createJobSchema } from '../../data/validators'
import { getItemProcessingQueue } from '../../lib/queue'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['item_processing.view'] },
  POST: { requireAuth: true, requireFeatures: ['item_processing.run'] },
}

export const openApi = {
  tags: ['ItemProcessing'],
  summary: 'List or create processing jobs',
}

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const status = url.searchParams.get('status') || undefined
  const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10)
  const pageSize = Number.parseInt(url.searchParams.get('pageSize') ?? '50', 10)

  const container = await createRequestContainer()
  const jobService = container.resolve('itemProcessingJobService') as JobService

  const result = await jobService.listJobs(
    { status: status as any, page, pageSize },
    { organizationId: auth.orgId, tenantId: auth.tenantId },
  )

  return NextResponse.json({ items: result.items, total: result.total, page, pageSize })
}

export async function POST(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const payload = await readJsonSafe(req)
  const parsed = createJobSchema.safeParse(payload)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 422 })
  }

  const container = await createRequestContainer()
  const jobService = container.resolve('itemProcessingJobService') as JobService
  const pipelineService = container.resolve('itemProcessingPipelineService') as PipelineService

  const scope = { organizationId: auth.orgId, tenantId: auth.tenantId, userId: auth.sub }

  const pipeline = await pipelineService.getPipelineByKey(parsed.data.pipelineKey, scope)
  if (!pipeline) {
    return NextResponse.json({ error: `Pipeline "${parsed.data.pipelineKey}" not found` }, { status: 404 })
  }

  const job = await jobService.createJob(
    {
      pipelineId: pipeline.id,
      name: parsed.data.name,
      items: parsed.data.items,
      config: pipeline.steps,
      sourceType: parsed.data.sourceType,
      sourceId: parsed.data.sourceId,
    },
    scope,
  )

  if (parsed.data.autoStart) {
    const queue = getItemProcessingQueue()
    await queue.enqueue({
      jobId: job.id,
      action: 'run',
      scope: { organizationId: scope.organizationId, tenantId: scope.tenantId, userId: scope.userId },
    })
  }

  return NextResponse.json(
    { id: job.id, status: job.status, totalItems: job.totalItems, pipelineId: pipeline.id },
    { status: 201 },
  )
}
