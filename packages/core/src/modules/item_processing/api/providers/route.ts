import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { getAllStepProviders } from '../../lib/provider-registry'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['item_processing.view'] },
}

export const openApi = {
  tags: ['ItemProcessing'],
  summary: 'List registered step providers',
}

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.tenantId || !auth.orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const providers = getAllStepProviders().map((p) => ({
    providerKey: p.providerKey,
    displayName: p.displayName,
    description: p.description ?? null,
    category: p.category,
  }))

  return NextResponse.json({ items: providers })
}
