import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ProcessingItem } from '../../../../../../data/entities'
import { submitItemReviewSchema } from '../../../../../../data/validators'

export const metadata = {
  PUT: { requireAuth: true, requireFeatures: ['item_processing.review'] },
}

export const openApi = {
  tags: ['ItemProcessing'],
  summary: 'Submit review for a single item',
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: jobId, itemId } = await params

  const payload = await readJsonSafe(req)
  const parsed = submitItemReviewSchema.safeParse(payload)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 422 })
  }

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager

  const item = await em.findOne(ProcessingItem, {
    id: itemId,
    jobId,
    tenantId: auth.tenantId,
  })

  if (!item) {
    return NextResponse.json({ error: 'Item not found' }, { status: 404 })
  }
  if (item.status !== 'awaiting_review') {
    return NextResponse.json({ error: `Item status is "${item.status}", expected "awaiting_review"` }, { status: 409 })
  }

  const currentStep = item.currentStep ?? 'review'
  const selectedValues = { ...(item.selectedValues ?? {}), [currentStep]: parsed.data.selectedValue }

  await em.nativeUpdate(ProcessingItem, { id: itemId }, { selectedValues })

  return NextResponse.json({ id: itemId, status: 'review_submitted' })
}
