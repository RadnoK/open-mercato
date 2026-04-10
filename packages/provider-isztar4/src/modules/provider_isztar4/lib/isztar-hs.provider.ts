import type { StepProvider, StepProviderInput, StepProviderResult, StepSuggestion } from '@open-mercato/core/modules/item_processing/lib/types'

// ─── ISZTAR4 API Types ─────────────────────────────────────────────────────

interface IsztarNomenclatureNode {
  code?: string
  description: string
  subgroup?: IsztarNomenclatureNode[]
}

interface IsztarCodeMatch {
  code: string
  description: string
  fullPath: string
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ISZTAR4_BASE_URL = 'https://ext-isztar4.mf.gov.pl/tariff/rest'
const REQUEST_TIMEOUT_MS = 10_000
const MAX_PAGES_TO_SCAN = 5
const MAX_SUGGESTIONS = 10
const MAX_DESCRIPTION_LENGTH = 200

// ─── ISZTAR4 API Client ────────────────────────────────────────────────────

async function fetchNomenclaturePage(page: number, language: string, date: string): Promise<IsztarNomenclatureNode[]> {
  const url = `${ISZTAR4_BASE_URL}/goods-nomenclature/codes?language=${language}&date=${date}&page=${page}`

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`ISZTAR4 API error: HTTP ${response.status}`)
  }

  const data = await response.json()

  if (Array.isArray(data)) return data
  if (data && typeof data === 'object' && Array.isArray(data.data)) return data.data
  if (data && typeof data === 'object' && data.subgroup) return [data]

  return Array.isArray(data) ? data : [data]
}

function flattenTree(
  nodes: IsztarNomenclatureNode[],
  parentPath: string,
  results: IsztarCodeMatch[],
): void {
  for (const node of nodes) {
    const cleanDesc = node.description.replace(/^[-\s]+/, '').trim()
    const currentPath = parentPath ? `${parentPath} > ${cleanDesc}` : cleanDesc

    if (node.code) {
      results.push({
        code: node.code,
        description: cleanDesc,
        fullPath: currentPath,
      })
    }

    if (node.subgroup && node.subgroup.length > 0) {
      flattenTree(node.subgroup, currentPath, results)
    }
  }
}

function normalizeForSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0142/g, 'l')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function searchCodes(allCodes: IsztarCodeMatch[], query: string): IsztarCodeMatch[] {
  const normalizedQuery = normalizeForSearch(query)
  const queryTerms = normalizedQuery.split(' ').filter(Boolean)

  if (queryTerms.length === 0) return []

  const scored = allCodes
    .map((code) => {
      const normalizedDesc = normalizeForSearch(code.description)
      const normalizedPath = normalizeForSearch(code.fullPath)

      let score = 0

      if (normalizedDesc.includes(normalizedQuery)) {
        score += 100
      }

      if (normalizedPath.includes(normalizedQuery)) {
        score += 50
      }

      for (const term of queryTerms) {
        if (normalizedDesc.includes(term)) score += 20
        if (normalizedPath.includes(term)) score += 5
      }

      return { code, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, MAX_SUGGESTIONS).map(({ code }) => code)
}

// ─── Provider ───────────────────────────────────────────────────────────────

export const isztarHsProvider: StepProvider = {
  providerKey: 'isztar_hs_classification',
  displayName: 'ISZTAR4 HS Code Classification',
  description: 'Classify items using Polish customs tariff API (ISZTAR4)',
  category: 'classification',

  async processItem(input: StepProviderInput): Promise<StepProviderResult> {
    const description = String(
      input.itemData.description_pl ?? input.itemData.description ?? '',
    ).trim()

    if (!description) {
      return { status: 'error', error: 'No description available for HS classification' }
    }

    const query = description.slice(0, MAX_DESCRIPTION_LENGTH)
    const today = new Date().toISOString().split('T')[0]

    const allCodes: IsztarCodeMatch[] = []
    for (let page = 1; page <= MAX_PAGES_TO_SCAN; page++) {
      try {
        const nodes = await fetchNomenclaturePage(page, 'PL', today)
        if (!nodes || nodes.length === 0) break
        flattenTree(nodes, '', allCodes)
      } catch {
        if (page === 1) throw new Error('ISZTAR4 API unavailable')
        break
      }
    }

    const matches = searchCodes(allCodes, query)

    if (matches.length === 0) {
      return { status: 'needs_review', suggestions: [], confidence: 0 }
    }

    const suggestions: StepSuggestion[] = matches.map((match, index) => ({
      id: match.code,
      label: `${match.code} — ${match.description}`,
      description: match.fullPath,
      value: { hsCode: match.code, hsDescription: match.description },
      confidence: Math.max(0, 100 - index * 15),
    }))

    return {
      status: 'needs_review',
      suggestions,
      confidence: suggestions[0]?.confidence ?? 0,
    }
  },
}
