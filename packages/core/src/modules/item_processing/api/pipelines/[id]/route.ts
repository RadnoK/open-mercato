import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { PipelineService } from '../../../lib/pipeline-service'
import { updatePipelineSchema } from '../../../data/validators'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['item_processing.view'] },
  PUT: { requireAuth: true, requireFeatures: ['item_processing.configure'] },
}

export const openApi = {
  tags: ['ItemProcessing'],
  summary: 'Get or update a processing pipeline',
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const container = await createRequestContainer()
  const pipelineService = container.resolve('itemProcessingPipelineService') as PipelineService

  const pipeline = await pipelineService.getPipeline(id, {
    organizationId: auth.orgId,
    tenantId: auth.tenantId,
  })

  if (!pipeline) {
    return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 })
  }

  return NextResponse.json(pipeline)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const payload = await readJsonSafe(req)
  const parsed = updatePipelineSchema.safeParse(payload)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 422 })
  }

  const container = await createRequestContainer()
  const pipelineService = container.resolve('itemProcessingPipelineService') as PipelineService

  try {
    const pipeline = await pipelineService.updatePipeline(id, parsed.data, {
      organizationId: auth.orgId,
      tenantId: auth.tenantId,
    })
    if (!pipeline) {
      return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 })
    }
    return NextResponse.json(pipeline)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 422 })
  }
}
