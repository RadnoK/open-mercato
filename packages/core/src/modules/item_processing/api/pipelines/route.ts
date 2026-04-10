import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { PipelineService } from '../../lib/pipeline-service'
import { createPipelineSchema } from '../../data/validators'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['item_processing.view'] },
  POST: { requireAuth: true, requireFeatures: ['item_processing.configure'] },
}

export const openApi = {
  tags: ['ItemProcessing'],
  summary: 'List or create processing pipelines',
}

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const container = await createRequestContainer()
  const pipelineService = container.resolve('itemProcessingPipelineService') as PipelineService

  const pipelines = await pipelineService.listPipelines({
    organizationId: auth.orgId,
    tenantId: auth.tenantId,
  })

  return NextResponse.json({ items: pipelines })
}

export async function POST(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const payload = await readJsonSafe(req)
  const parsed = createPipelineSchema.safeParse(payload)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 422 })
  }

  const container = await createRequestContainer()
  const pipelineService = container.resolve('itemProcessingPipelineService') as PipelineService

  try {
    const pipeline = await pipelineService.createPipeline(parsed.data, {
      organizationId: auth.orgId,
      tenantId: auth.tenantId,
    })
    return NextResponse.json(pipeline, { status: 201 })
  } catch (err: any) {
    if (err.status === 409) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    return NextResponse.json({ error: err.message }, { status: 422 })
  }
}
