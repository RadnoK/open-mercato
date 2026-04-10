import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ProcessingItem, ProcessingJob } from '../../../../../data/entities'
import { bulkSubmitReviewSchema } from '../../../../../data/validators'
import { getItemProcessingQueue } from '../../../../../lib/queue'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['item_processing.review'] },
}

export const openApi = {
  tags: ['ItemProcessing'],
  summary: 'Bulk submit reviews and optionally resume job',
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: jobId } = await params

  const payload = await readJsonSafe(req)
  const parsed = bulkSubmitReviewSchema.safeParse(payload)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 422 })
  }

  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const scope = { organizationId: auth.orgId, tenantId: auth.tenantId, userId: auth.sub }

  // Validate all items belong to this job
  const itemIds = parsed.data.selections.map((s) => s.itemId)
  const items = await em.find(ProcessingItem, {
    id: { $in: itemIds },
    tenantId: auth.tenantId,
  })

  const crossJobItems = items.filter((i) => i.jobId !== jobId)
  if (crossJobItems.length > 0) {
    return NextResponse.json({ error: 'All items must belong to the same job' }, { status: 422 })
  }

  // Save selections
  for (const selection of parsed.data.selections) {
    const item = items.find((i) => i.id === selection.itemId)
    if (!item) continue

    const currentStep = item.currentStep ?? 'review'
    const selectedValues = { ...(item.selectedValues ?? {}), [currentStep]: selection.selectedValue }
    await em.nativeUpdate(ProcessingItem, { id: selection.itemId }, { selectedValues })
  }

  let resumed = false

  if (parsed.data.resume) {
    const job = await em.findOne(ProcessingJob, { id: jobId, tenantId: auth.tenantId })
    if (job && job.status === 'paused') {
      const queue = getItemProcessingQueue()
      await queue.enqueue({
        jobId,
        action: 'resume',
        scope: { organizationId: scope.organizationId, tenantId: scope.tenantId, userId: scope.userId },
      })
      resumed = true
    } else if (job && job.status !== 'paused') {
      return NextResponse.json({ error: `Job status is "${job?.status}", expected "paused" for resume` }, { status: 409 })
    }
  }

  return NextResponse.json({ submitted: parsed.data.selections.length, resumed })
}
