# WS-5: Providers + Demo + MCP Tools

**Kto**: Osoba B
**Branch**: `feature/ip-providers`
**Czas**: ~7h
**Zalezy od**: WS-3 (API + UI)

---

## Cel

Cztery built-in providery, ISZTAR4 demo provider, MCP tools (ai-tools.ts), widget injection. Po tym workstreamie mozna uruchamiac prawdziwe pipeline z AI translation, validation, HTTP calls i customs HS classification.

## Pliki do stworzenia

### 1. `providers/ai-transform.provider.ts` — Generyczny AI provider

Najwazniejszy built-in. Prompt template + structured output.

```typescript
import type { StepProvider, StepProviderInput, StepProviderResult } from '../lib/types'

export const aiTransformProvider: StepProvider = {
  providerKey: 'ai_transform',
  displayName: 'AI Transform',
  description: 'Generic AI processing with prompt template and structured output',
  category: 'transformation',

  async processItem(input: StepProviderInput): Promise<StepProviderResult> {
    const { itemData, stepConfig } = input
    const prompt = stepConfig.prompt as string
    const outputSchema = stepConfig.outputSchema as Record<string, string> | undefined
    
    if (!prompt) return { status: 'error', error: 'Missing prompt in providerConfig' }

    // 1. Interpolate {{field}} in prompt with itemData values
    const interpolatedPrompt = interpolateTemplate(prompt, itemData)

    // 2. Build zod schema from outputSchema config (dynamic)
    //    NOTE: Use AI SDK v6 pattern: generateText with output: Output.object({ schema })
    //    If no outputSchema → use plain generateText

    // 3. Call AI, return result
    return { status: 'success', data: result }
  },
}
```

**Interpolation**: `{{field}}` → `itemData[field]`. `{{nested.field}}` → dot-notation resolve. Undefined → empty string.

**Dynamic Zod from config**: `{ "category": "string" }` → `z.object({ category: z.string() })`. Map: string→z.string(), number→z.number(), boolean→z.boolean(), array→z.array(z.unknown()).

**Edge cases**:
- Brak prompt → error
- Brak outputSchema → plain text response wrapped in `{ text: result }`
- AI rate limit → throw (engine retry)
- Template var undefined → empty string
- outputSchema unknown type → z.string() fallback

### 2. `providers/ai-translate.provider.ts` — Tlumaczenie

```typescript
export const aiTranslateProvider: StepProvider = {
  providerKey: 'ai_translate',
  displayName: 'AI Translate',
  description: 'Translate item fields to target language using AI',
  category: 'transformation',

  async processItem(input): Promise<StepProviderResult> {
    const { itemData, stepConfig } = input
    const targetLang = stepConfig.targetLang as string
    const fields = (stepConfig.fields as string[]) ?? Object.keys(itemData)

    if (!targetLang) return { status: 'error', error: 'Missing targetLang' }

    const translations: Record<string, string> = {}
    for (const field of fields) {
      const value = itemData[field]
      if (!value || typeof value !== 'string' || !value.trim()) continue
      
      // Call AI: "Translate to {targetLang}. Return only the translation: {value}"
      const translated = await translateField(value, targetLang)
      translations[`${field}_${targetLang}`] = translated
    }

    return { status: 'success', data: translations }
  },
}
```

**Edge cases**: empty fields → skip, non-string → skip, empty result fields list → translate all string fields

### 3. `providers/schema-validate.provider.ts` — Walidacja

```typescript
export const schemaValidateProvider: StepProvider = {
  providerKey: 'schema_validate',
  displayName: 'Schema Validate',
  description: 'Validate item data against a JSON schema definition',
  category: 'validation',

  async processItem(input): Promise<StepProviderResult> {
    const schema = input.stepConfig.schema as Record<string, unknown>
    if (!schema) return { status: 'error', error: 'Missing schema in providerConfig' }

    const zodSchema = buildZodFromConfig(schema)
    const result = zodSchema.safeParse(input.itemData)

    if (result.success) {
      return { status: 'success', data: { valid: true, errors: [] } }
    }
    return {
      status: 'error',
      error: 'Validation failed',
      data: { valid: false, errors: result.error.flatten().fieldErrors },
    }
  },
}
```

**Uwaga**: Provider zwraca `status: 'error'` dla failed validation. Engine: jesli step.optional → kontynuuj (validation errors saved in step_results, item not marked failed).

### 4. `providers/http-webhook.provider.ts` — Generyczny HTTP

```typescript
export const httpWebhookProvider: StepProvider = {
  providerKey: 'http_webhook',
  displayName: 'HTTP Webhook',
  description: 'Call external HTTP API with configurable URL, headers, body template',
  category: 'enrichment',

  async processItem(input): Promise<StepProviderResult> {
    const config = input.stepConfig
    const url = interpolateTemplate(config.url as string, input.itemData)
    const method = (config.method as string) ?? 'POST'
    const timeout = (config.timeout as number) ?? 10000
    const headers = interpolateRecord(config.headers as Record<string, string> ?? {}, input.itemData)
    const bodyTemplate = config.bodyTemplate as Record<string, unknown> | undefined

    const body = bodyTemplate
      ? JSON.stringify(interpolateDeep(bodyTemplate, input.itemData))
      : undefined

    const response = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body,
      signal: AbortSignal.timeout(timeout),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { status: 'error', error: `HTTP ${response.status}: ${text.slice(0, 500)}` }
    }

    const responseData = await response.json().catch(() => null)
    if (!responseData) return { status: 'error', error: 'Response is not JSON' }

    // Apply responseMapping
    const mapped = applyResponseMapping(responseData, config.responseMapping as Record<string, string> ?? {})
    return { status: 'success', data: mapped }
  },
}
```

**`interpolateTemplate`**: `{{field}}` → itemData[field], `{{env.VAR}}` → process.env[VAR]. Undefined → empty string.

**`interpolateDeep`**: Recursively interpolate all string values in an object tree.

**`applyResponseMapping`**: `{ "code": "result.items[0].code" }` → resolve dot-notation on response.

**Edge cases**: non-2xx → error, not JSON → error, timeout → error, env var missing → empty string

### 5. Shared utility: `providers/utils.ts`

```typescript
// Shared between all providers

export function interpolateTemplate(template: string, data: Record<string, unknown>): string
// Replace {{field}} and {{nested.field}} and {{env.VAR}}

export function resolveDeep(obj: unknown, path: string): unknown
// Resolve dot-notation path on object

export function interpolateDeep(obj: unknown, data: Record<string, unknown>): unknown
// Recursively interpolate all strings in object tree

export function interpolateRecord(record: Record<string, string>, data: Record<string, unknown>): Record<string, string>
// Interpolate all values in a flat record

export function applyResponseMapping(response: unknown, mapping: Record<string, string>): Record<string, unknown>
// Map response fields via dot-notation paths

export function buildZodFromConfig(schema: Record<string, unknown>): z.ZodType
// Build zod schema from JSON config. Types: string, number, boolean, array.
// Supports: required, minLength, maxLength, min, max
```

### 6. ISZTAR4 Demo Provider

```typescript
export const isztarHsProvider: StepProvider = {
  providerKey: 'isztar_hs_classification',
  displayName: 'ISZTAR4 HS Code Classification',
  description: 'Classify items using Polish customs tariff API (ISZTAR4)',
  category: 'classification',

  async processItem(input): Promise<StepProviderResult> {
    const description = String(
      input.itemData.description_pl ?? input.itemData.description ?? ''
    ).trim()

    if (!description) {
      return { status: 'error', error: 'No description available for HS classification' }
    }

    const results = await queryIsztar4Api(description.slice(0, 200))

    if (results.length === 0) {
      return { status: 'needs_review', suggestions: [], confidence: 0 }
    }

    return {
      status: 'needs_review',
      suggestions: results.map((r, i) => ({
        id: r.code,
        label: `${r.code} — ${r.description}`,
        description: r.fullPath ?? '',
        value: { hsCode: r.code, hsDescription: r.description },
        confidence: Math.max(0, 100 - i * 15),
      })),
      confidence: Math.min(results[0]?.confidence ?? 85, 100),
    }
  },
}

async function queryIsztar4Api(query: string): Promise<IsztarResult[]> {
  // Call https://ext-isztar4.mf.gov.pl/taryfa_celna/api/...
  // Parse response into { code, description, fullPath }[]
  // Handle: timeout 10s, non-2xx → throw, empty results → []
}
```

**Rejestracja**: W `di.ts` (WS-6):
```typescript
registerStepProvider(isztarHsProvider)
```

### 7. `ai-tools.ts` — MCP Tools

6 narzedzi (5 od Osoby B + 1 od Osoby A w WS-4):

```typescript
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ProcessingJob, ProcessingItem, ProcessingPipeline } from './data/entities'
import { getAllStepProviders } from './lib/provider-registry'

type ToolContext = {
  tenantId: string | null
  organizationId: string | null
  userId: string | null
  container: any
  userFeatures: string[]
}

function requireScope(ctx: ToolContext) {
  if (!ctx.tenantId || !ctx.organizationId) throw new Error('Tenant context required')
  return { tenantId: ctx.tenantId, organizationId: ctx.organizationId, userId: ctx.userId }
}

export const aiTools = [
  // 1. Create job
  {
    name: 'item_processing_create_job',
    description: 'Create a new processing job. Provide pipeline key and items array. Returns job ID. Use item_processing_get_job to check progress.',
    inputSchema: z.object({
      pipelineKey: z.string(),
      items: z.array(z.record(z.unknown())).min(1),
      name: z.string().optional(),
      autoStart: z.boolean().optional().default(true),
    }),
    requiredFeatures: ['item_processing.run'],
    handler: async (input, ctx) => {
      const scope = requireScope(ctx)
      const em = ctx.container.resolve('em').fork()
      // resolve pipeline, create job, optionally enqueue
      // return { jobId, status, totalItems }
    },
  },
  // 2. Get job
  {
    name: 'item_processing_get_job',
    description: 'Get job status, progress, and items with step results. Shows per-item status and any suggestions awaiting review.',
    inputSchema: z.object({
      jobId: z.string().uuid(),
      includeItems: z.boolean().optional().default(true),
      itemLimit: z.number().optional().default(50),
    }),
    requiredFeatures: ['item_processing.view'],
    handler: async (input, ctx) => {
      // load job + items, return full status
    },
  },
  // 3. Submit review
  {
    name: 'item_processing_submit_review',
    description: 'Submit review selections for items awaiting review. Maps item IDs to chosen values. Resumes job processing.',
    inputSchema: z.object({
      jobId: z.string().uuid(),
      selections: z.array(z.object({
        itemId: z.string().uuid(),
        selectedValue: z.record(z.unknown()),
      })).min(1),
    }),
    requiredFeatures: ['item_processing.review'],
    handler: async (input, ctx) => {
      // save selections, enqueue resume
    },
  },
  // 4. List pipelines
  {
    name: 'item_processing_list_pipelines',
    description: 'List all available processing pipelines with their step definitions and provider configurations.',
    inputSchema: z.object({}),
    requiredFeatures: ['item_processing.view'],
    handler: async (input, ctx) => {
      const scope = requireScope(ctx)
      const em = ctx.container.resolve('em').fork()
      const pipelines = await em.find(ProcessingPipeline, { tenantId: scope.tenantId, isActive: true, deletedAt: null })
      return { pipelines: pipelines.map(p => ({ id: p.id, key: p.pipelineKey, name: p.name, steps: p.steps })) }
    },
  },
  // 5. List providers
  {
    name: 'item_processing_list_providers',
    description: 'List all registered step providers with their capabilities.',
    inputSchema: z.object({}),
    requiredFeatures: ['item_processing.view'],
    handler: async () => {
      const providers = getAllStepProviders()
      return { providers: providers.map(p => ({ key: p.providerKey, name: p.displayName, category: p.category, description: p.description })) }
    },
  },
  // 6. Design pipeline (placeholder — Osoba A implementuje handler w WS-4)
  // {
  //   name: 'item_processing_design_pipeline',
  //   ... (added by Osoba A in WS-4 merge)
  // },
]
```

### 8. Widget Injection

#### `widgets/injection/ProcessItemsAction.tsx`

Headless widget (no React component — exports menuItems):

```typescript
export const metadata = {
  id: 'item_processing.bulk.process_items',
}

export const menuItems = [
  {
    id: 'item-processing-bulk-process',
    labelKey: 'item_processing.actions.process_items',
    icon: 'lucide:play',
    action: 'navigate',
    href: '/backend/item-processing/jobs/create',
  },
]
```

#### `widgets/injection-table.ts`

```typescript
export const injectionTable = {}
export default injectionTable
```

Empty for now — other modules map the widget to their DataTable spots. The widget itself is generic and reusable.

## Definition of Done

- [ ] ai_transform provider works (prompt + schema → structured output)
- [ ] ai_translate provider works (field translation)
- [ ] schema_validate provider works (zod from config)
- [ ] http_webhook provider works (HTTP call + response mapping)
- [ ] ISZTAR4 provider returns HS code suggestions (live API)
- [ ] Shared utils (interpolation, mapping) tested
- [ ] 5 MCP tools respond correctly
- [ ] Widget injection files created
- [ ] `yarn build` passes on branch
