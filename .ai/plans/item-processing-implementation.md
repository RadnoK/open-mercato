# Plan implementacji: modul `item_processing`

**Data**: 2026-04-10
**Spec**: `.ai/specs/2026-04-10-item-processing-module.md`
**Lokalizacja modulu**: `packages/core/src/modules/item_processing/`

---

## Faza 1 — Scaffold + Data Layer

### 1.1 `index.ts`

```typescript
import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'item_processing',
  title: 'Item Processing',
  version: '0.1.0',
  description: 'Generic pipeline for batch item enrichment with pluggable providers and human-in-the-loop review.',
  author: 'Open Mercato Team',
  license: 'Proprietary',
  ejectable: true,
}

export { features } from './acl'
```

### 1.2 `acl.ts`

```typescript
export const features = [
  { id: 'item_processing.view', title: 'View processing jobs and results', module: 'item_processing' },
  { id: 'item_processing.run', title: 'Create and run processing jobs', module: 'item_processing' },
  { id: 'item_processing.review', title: 'Submit review selections', module: 'item_processing' },
  { id: 'item_processing.configure', title: 'Manage pipeline configurations', module: 'item_processing' },
]

export default features
```

### 1.3 `events.ts`

```typescript
import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  { id: 'item_processing.job.created', label: 'Job Created', entity: 'job', category: 'crud' },
  { id: 'item_processing.job.updated', label: 'Job Updated', entity: 'job', category: 'crud' },
  { id: 'item_processing.job.deleted', label: 'Job Deleted', entity: 'job', category: 'crud' },
  { id: 'item_processing.job.started', label: 'Job Started', entity: 'job', category: 'lifecycle' },
  { id: 'item_processing.job.step_completed', label: 'Step Completed', entity: 'job', category: 'lifecycle', clientBroadcast: true },
  { id: 'item_processing.job.paused_for_review', label: 'Paused for Review', entity: 'job', category: 'lifecycle', clientBroadcast: true },
  { id: 'item_processing.job.completed', label: 'Job Completed', entity: 'job', category: 'lifecycle', clientBroadcast: true },
  { id: 'item_processing.job.failed', label: 'Job Failed', entity: 'job', category: 'lifecycle', clientBroadcast: true },
  { id: 'item_processing.item.processed', label: 'Item Processed', entity: 'item', category: 'lifecycle' },
  { id: 'item_processing.item.review_submitted', label: 'Review Submitted', entity: 'item', category: 'lifecycle' },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'item_processing',
  events,
})

export const emitItemProcessingEvent = eventsConfig.emit
export type ItemProcessingEventId = typeof events[number]['id']
export default eventsConfig
```

### 1.4 `data/entities.ts`

Trzy encje MikroORM. Wzorce:
- UUID PK z `defaultRaw: 'gen_random_uuid()'`
- `organization_id` + `tenant_id` na kazdej encji
- Timestamps z `onCreate` / `onUpdate`
- `[OptionalProps]` dla pol z defaultami
- snake_case column names z `@Property({ name: '...' })`
- `@Index` na polach filtrowanych

**ProcessingPipeline**:
- PK, org/tenant scoping
- `pipeline_key` text UNIQUE per tenant (compound index z tenant_id)
- `name` text, `description` text nullable
- `steps` jsonb (typ: `PipelineStepDefinition[]`)
- `webhook_url` text nullable (na completion callback)
- `is_active` boolean default true
- `created_by` uuid nullable
- timestamps + soft delete

**ProcessingJob**:
- PK, org/tenant scoping
- `pipeline_id` uuid FK → processing_pipelines
- `name` text nullable
- `status` text: `'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'`
- `current_step` text nullable
- `total_items` int default 0
- `processed_items` int default 0
- `failed_items` int default 0
- `skipped_items` int default 0
- `progress_job_id` uuid nullable
- `source_type` text nullable: `'manual' | 'document_parser' | 'csv' | 'api'`
- `source_id` uuid nullable
- `config` jsonb nullable (snapshot pipeline steps at creation)
- `result_summary` jsonb nullable
- `started_at` timestamptz nullable
- `completed_at` timestamptz nullable
- `created_by` uuid nullable
- timestamps + soft delete
- Index na `(tenant_id, organization_id)`, `status`, `pipeline_id`

**ProcessingItem**:
- PK, org/tenant scoping
- `job_id` uuid FK → processing_jobs
- `item_index` int
- `status` text: `'pending' | 'processing' | 'awaiting_review' | 'completed' | 'failed' | 'skipped'`
- `current_step` text nullable
- `input_data` jsonb NOT NULL
- `output_data` jsonb nullable (accumulated enrichment)
- `step_results` jsonb nullable (`{ [stepKey]: StepProviderResult }`)
- `selected_values` jsonb nullable (`{ [stepKey]: unknown }`)
- `error_message` text nullable
- timestamps (bez soft delete — items zyja z jobem)
- Index na `(job_id)`, `(job_id, status)`

### 1.5 `data/validators.ts`

Zod schemas:

```typescript
import { z } from 'zod'

const uuid = () => z.string().uuid()

// --- Step condition ---
export const stepConditionSchema = z.object({
  field: z.string().min(1),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains']),
  value: z.unknown(),
})

// --- Pipeline step definition ---
export const pipelineStepSchema = z.object({
  stepKey: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(200),
  type: z.enum(['automated', 'review']),
  providerKey: z.string().min(1).max(100).optional(),
  providerConfig: z.record(z.unknown()).optional(),
  inputMapping: z.record(z.string()).optional(),
  outputMapping: z.record(z.string()).optional(),
  optional: z.boolean().optional(),
  retryPolicy: z.object({
    maxRetries: z.number().int().min(0).max(10),
    backoffMs: z.number().int().min(100).max(60000),
  }).optional(),
  condition: z.union([stepConditionSchema, z.array(stepConditionSchema)]).optional(),
})

// --- Pipeline CRUD ---
export const createPipelineSchema = z.object({
  pipelineKey: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  steps: z.array(pipelineStepSchema).min(1).max(50),
  webhookUrl: z.string().url().optional(),
})

export const updatePipelineSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  steps: z.array(pipelineStepSchema).min(1).max(50).optional(),
  webhookUrl: z.string().url().nullable().optional(),
  isActive: z.boolean().optional(),
})

// --- Job CRUD ---
export const createJobSchema = z.object({
  pipelineKey: z.string().min(1),
  name: z.string().max(200).optional(),
  items: z.array(z.record(z.unknown())).min(1).max(10000),
  sourceType: z.enum(['manual', 'document_parser', 'csv', 'api']).optional(),
  sourceId: uuid().optional(),
  autoStart: z.boolean().optional(), // jesli true, od razu enqueue
})

// --- Review ---
export const submitItemReviewSchema = z.object({
  selectedValue: z.record(z.unknown()),
})

export const bulkSubmitReviewSchema = z.object({
  selections: z.array(z.object({
    itemId: uuid(),
    selectedValue: z.record(z.unknown()),
  })).min(1),
  resume: z.boolean().optional().default(true),
})

// --- Derived types ---
export type StepConditionInput = z.infer<typeof stepConditionSchema>
export type PipelineStepInput = z.infer<typeof pipelineStepSchema>
export type CreatePipelineInput = z.infer<typeof createPipelineSchema>
export type UpdatePipelineInput = z.infer<typeof updatePipelineSchema>
export type CreateJobInput = z.infer<typeof createJobSchema>
export type SubmitItemReviewInput = z.infer<typeof submitItemReviewSchema>
export type BulkSubmitReviewInput = z.infer<typeof bulkSubmitReviewSchema>
```

**Walidacja edge cases**:
- `stepKey` musi byc unique w ramach jednego pipeline (walidacja w pipeline-service)
- `providerKey` wymagany gdy `type === 'automated'` (walidacja w pipeline-service)
- `items` max 10000 — zabezpieczenie przed memory pressure
- `steps` max 50 — rozsadny limit
- `pipelineKey` regex: lowercase + digits + underscores, zaczyna sie od litery

### 1.6 `lib/types.ts`

Glowne interfejsy. Eksportowane z modulu — inne modul moglyby importowac.

```typescript
export interface StepProvider {
  readonly providerKey: string
  readonly displayName: string
  readonly description?: string
  readonly category: 'classification' | 'enrichment' | 'validation' | 'transformation'

  processItem(input: StepProviderInput): Promise<StepProviderResult>
  processBatch?(inputs: StepProviderInput[]): Promise<StepProviderResult[]>
  validateConfig?(config: Record<string, unknown>): Promise<StepProviderValidation>
}

export interface StepProviderInput {
  itemId: string
  itemIndex: number
  itemData: Record<string, unknown>
  stepConfig: Record<string, unknown>
  scope: TenantScope
}

export interface StepProviderResult {
  status: 'success' | 'error' | 'needs_review'
  data?: Record<string, unknown>
  suggestions?: StepSuggestion[]
  confidence?: number
  error?: string
}

export interface StepSuggestion {
  id: string
  label: string
  description?: string
  value: Record<string, unknown>
  confidence?: number
  metadata?: Record<string, unknown>
}

export interface StepProviderValidation {
  valid: boolean
  message?: string
}

export interface TenantScope {
  organizationId: string
  tenantId: string
  userId?: string | null
}

export interface StepCondition {
  field: string
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'contains'
  value: unknown
}

export interface PipelineStepDefinition {
  stepKey: string
  label: string
  type: 'automated' | 'review'
  providerKey?: string
  providerConfig?: Record<string, unknown>
  inputMapping?: Record<string, string>
  outputMapping?: Record<string, string>
  optional?: boolean
  retryPolicy?: { maxRetries: number; backoffMs: number }
  condition?: StepCondition | StepCondition[]
}
```

### 1.7 `setup.ts`

```typescript
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['item_processing.*'],
    employee: ['item_processing.view', 'item_processing.run', 'item_processing.review'],
  },

  async seedDefaults({ em, tenantId, organizationId }) {
    // Upsert template pipelines by pipelineKey
    // customs_hs_classification, product_data_validation, generic_ai_enrichment
    // Uzyj em.upsert lub findOne + create pattern
  },
}

export default setup
```

### 1.8 Migracja

Po stworzeniu entities: `yarn db:generate`

---

## Faza 2 — Core Engine

### 2.1 `lib/provider-registry.ts`

Identyczny wzorzec jak `data_sync/lib/adapter-registry.ts`:

```typescript
import type { StepProvider } from './types'

const providers = new Map<string, StepProvider>()

export function registerStepProvider(provider: StepProvider): void {
  providers.set(provider.providerKey, provider)
}

export function getStepProvider(providerKey: string): StepProvider | undefined {
  return providers.get(providerKey)
}

export function getAllStepProviders(): StepProvider[] {
  return Array.from(providers.values())
}
```

### 2.2 `lib/condition-evaluator.ts`

Ewaluacja `StepCondition` na `item.step_results`.

```typescript
import type { StepCondition } from './types'

export function evaluateCondition(
  condition: StepCondition | StepCondition[],
  stepResults: Record<string, unknown>,
): boolean
```

**Algorytm**:
1. Jesli array → AND logic (wszystkie musza byc true)
2. Resolve `field` przez dot-notation na `stepResults` (np. `"classify_hs.confidence"` → `stepResults.classify_hs.confidence`)
3. Ewaluuj operator:
   - `eq`: `===` (strict equality)
   - `neq`: `!==`
   - `gt`, `gte`, `lt`, `lte`: numeric comparison (parseFloat jesli string)
   - `exists`: `value !== undefined && value !== null`
   - `contains`: `String(resolved).includes(String(condition.value))`

**Edge cases**:
- `field` nie istnieje w stepResults → zwroc `false` (step sie nie wykonal, nie mozna ewaluowac)
- `field` prowadzi do `null` → traktuj jak `undefined` dla `exists`, `false` dla porownania
- Nested path (np. `"step1.data.category"`) → iteruj po segmentach
- Non-numeric value przy gt/lt → zwroc `false` (nie crashuj)
- Empty conditions array `[]` → zwroc `true` (brak warunkow = zawsze wykonaj)
- `condition` undefined → zwroc `true`

### 2.3 `lib/job-service.ts`

Factory function pattern (jak `createSyncRunService`):

```typescript
import type { EntityManager } from '@mikro-orm/postgresql'
import type { TenantScope } from './types'

export function createJobService(em: EntityManager) {
  return {
    async createJob(input, scope: TenantScope): Promise<ProcessingJob>,
    async getJob(jobId: string, scope: TenantScope): Promise<ProcessingJob | null>,
    async listJobs(filters, scope: TenantScope): Promise<{ items: ProcessingJob[]; total: number }>,
    async updateStatus(jobId: string, status: string, scope: TenantScope, error?: string): Promise<ProcessingJob | null>,
    async updateCounters(jobId: string, delta: CounterDelta, scope: TenantScope): Promise<void>,
    async setCurrentStep(jobId: string, stepKey: string | null, scope: TenantScope): Promise<void>,
  }
}
```

**Status transitions** (walidowane w `updateStatus`):

| From | Allowed to |
|------|-----------|
| `pending` | `running`, `cancelled` |
| `running` | `paused`, `completed`, `failed`, `cancelled` |
| `paused` | `running`, `cancelled` |
| `completed` | (terminal) |
| `failed` | `pending` (retry) |
| `cancelled` | (terminal) |

**Edge case**: Concurrent status update — uzyj `em.nativeUpdate` z WHERE clause na aktualny status, sprawdz `affectedRows === 1`. Jesli 0 → throw "Stale status, job was modified concurrently".

### 2.4 `lib/pipeline-service.ts`

```typescript
export function createPipelineService(em: EntityManager) {
  return {
    async createPipeline(input: CreatePipelineInput, scope: TenantScope): Promise<ProcessingPipeline>,
    async getPipeline(id: string, scope: TenantScope): Promise<ProcessingPipeline | null>,
    async getPipelineByKey(key: string, scope: TenantScope): Promise<ProcessingPipeline | null>,
    async listPipelines(scope: TenantScope): Promise<ProcessingPipeline[]>,
    async updatePipeline(id: string, input: UpdatePipelineInput, scope: TenantScope): Promise<ProcessingPipeline | null>,
  }
}
```

**Walidacja przy create/update**:
- `stepKey` unique w ramach steps array
- Jesli `step.type === 'automated'` → `step.providerKey` MUSI byc podany
- Jesli `step.type === 'review'` → `step.providerKey` NIE powinien byc podany (warning, nie error)
- `pipelineKey` unique per tenant (compound: tenant_id + pipeline_key)
- Duplicate `pipelineKey` → return 409 Conflict

### 2.5 `lib/processing-engine.ts`

Glowny silnik. Wzorowany na `sync-engine.ts`.

```typescript
import type { EntityManager } from '@mikro-orm/postgresql'
import type { ProgressService } from '../../progress/lib/progressService'
import type { TenantScope, PipelineStepDefinition } from './types'

type EngineDeps = {
  em: EntityManager
  jobService: ReturnType<typeof createJobService>
  progressService: ProgressService
}

export function createProcessingEngine(deps: EngineDeps) {
  return {
    async runJob(jobId: string, scope: TenantScope): Promise<void>,
    async resumeAfterReview(jobId: string, scope: TenantScope): Promise<void>,
    async retryFailedItems(jobId: string, scope: TenantScope): Promise<void>,
  }
}
```

**`runJob` algorytm**:

```
1. Load job (assert status === 'pending' or 'running')
2. Load pipeline config z job.config (snapshot)
3. Mark job status → 'running', create ProgressJob
4. Emit event: job.started

5. For each step in pipeline.steps (od job.current_step lub poczatek):
   a. Set job.current_step = step.stepKey

   b. If step.type === 'review':
      - Set all pending items → 'awaiting_review'
      - Set job status → 'paused'
      - Emit event: job.paused_for_review
      - RETURN (stop processing, wait for resume)

   c. If step.type === 'automated':
      - Resolve provider = getStepProvider(step.providerKey)
      - If provider not found AND step.optional → skip step, continue
      - If provider not found AND !step.optional → fail job

      - Load items where status IN ('pending', 'processing')
        OR status === 'completed' (items that passed previous steps)
        Technically: all items that haven't failed/been skipped

      - For each item:
        i.  Evaluate condition (if defined):
            - If condition false → set item step_results[stepKey] = { status: 'skipped' }
            - Increment skipped counter, continue to next item

        ii. Build itemData:
            - Start with item.input_data
            - Merge item.output_data (accumulated)
            - Apply step.inputMapping (remap field names)

        iii. Call provider.processItem({ itemData, stepConfig: step.providerConfig, scope })
             - Wrap in try/catch
             - On error + retryPolicy → retry up to maxRetries with backoff
             - On final error + step.optional → mark item step as error, continue
             - On final error + !step.optional → mark item as 'failed', increment failed counter

        iv. Save result to item.step_results[stepKey]
        v.  Apply step.outputMapping to result.data → merge into item.output_data
        vi. If result.status === 'needs_review':
            - item stays pending (will be caught by next review step)
            - Store suggestions in step_results
        vii. Update progress (increment processed counter)

      - Emit event: job.step_completed

6. After all steps:
   - Mark all remaining non-failed items → 'completed'
   - Set job status → 'completed', set completed_at
   - Complete ProgressJob
   - Build result_summary: { completed, failed, skipped }
   - Emit event: job.completed
```

**`resumeAfterReview` algorytm**:

```
1. Load job (assert status === 'paused')
2. Find current step index from job.current_step in config.steps
3. Mark job status → 'running'
4. Items z status 'awaiting_review' → przenies do nastepnego statusu
   (jesli maja selected_values dla tego step → 'completed' na tym stepie)
   (jesli nie maja → zostaw jako 'pending' jesli next steps exist)
5. Continue runJob from next step (step index + 1)
```

**`retryFailedItems` algorytm**:

```
1. Load job (assert status === 'failed' or 'completed' with failed items)
2. Reset failed items: status → 'pending', clear error_message
3. Reset job counters (failed_items = 0)
4. Set job status → 'pending'
5. Enqueue job to worker queue
```

**Edge cases i error handling**:

| Scenariusz | Obsluga |
|-----------|---------|
| Provider throws exception | Catch, retry wg retryPolicy. Po wyczerpaniu retries: jesli step.optional → log error w step_results, continue. Jesli !optional → mark item failed. |
| Provider returns `{ status: 'error' }` | Traktuj jak exception bez retry (provider swiadomie zwrocil blad). Mark item failed jesli !optional. |
| Provider timeout (brak response) | Default timeout 30s. AbortController na fetch/API call. Traktuj jak exception. |
| All items failed | Job status → 'failed' (nie 'completed'). result_summary.allFailed = true. |
| 0 items to process | Job status → 'completed' immediately. Edge case: items array empty po create. |
| Job cancelled during processing | Sprawdzaj `progressService.isCancellationRequested(progressJobId)` po kazdym item. Jesli true → finalize jako 'cancelled'. |
| Concurrent runJob calls | Status transition walidacja: jesli job juz 'running' → reject z 409. |
| Pipeline has 0 automated steps (only review) | Job przejdzie od razu do paused. Valid use case. |
| Condition references non-existent step | `evaluateCondition` zwroci false → step skipped. Nie crash. |
| inputMapping references non-existent field | Mapped value = undefined. Provider dostanie undefined — moze obsluzyc lub zwrocic error. |
| outputMapping na result.data ktore jest undefined | Skip mapping. Nie nadpisuj output_data z undefined. |
| Item ma juz step_results z poprzedniego runa (retry) | Nadpisz step_results[stepKey] nowym wynikiem. Nie kumuluj historii. |
| processBatch available on provider | Jesli provider implementuje processBatch → uzyj go zamiast processItem w petli. Batch size: min(items.length, 50). Speedup dla API z batch endpoints. |
| Very large job (10000 items) | Nie laduj wszystkich items do pamieci naraz. Uzyj cursor-based pagination (em.find z limit+offset). Process in chunks of 100. |

### 2.6 `di.ts`

```typescript
import { asFunction, asValue } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { ProgressService } from '../progress/lib/progressService'
import { ProcessingJob, ProcessingItem, ProcessingPipeline } from './data/entities'
import { createJobService } from './lib/job-service'
import { createPipelineService } from './lib/pipeline-service'
import { createProcessingEngine } from './lib/processing-engine'

// Import and register built-in providers
import { aiTransformProvider } from './providers/ai-transform.provider'
import { aiTranslateProvider } from './providers/ai-translate.provider'
import { schemaValidateProvider } from './providers/schema-validate.provider'
import { httpWebhookProvider } from './providers/http-webhook.provider'
import { registerStepProvider } from './lib/provider-registry'

type Cradle = {
  em: EntityManager
  progressService: ProgressService
}

export function register(container: AppContainer) {
  // Register built-in providers
  registerStepProvider(aiTransformProvider)
  registerStepProvider(aiTranslateProvider)
  registerStepProvider(schemaValidateProvider)
  registerStepProvider(httpWebhookProvider)

  container.register({
    // Services
    itemProcessingJobService: asFunction(({ em }: Cradle) =>
      createJobService(em)
    ).scoped().proxy(),

    itemProcessingPipelineService: asFunction(({ em }: Cradle) =>
      createPipelineService(em)
    ).scoped().proxy(),

    itemProcessingEngine: asFunction(({ em, progressService, itemProcessingJobService }: Cradle & {
      itemProcessingJobService: ReturnType<typeof createJobService>
    }) =>
      createProcessingEngine({ em, jobService: itemProcessingJobService, progressService })
    ).scoped().proxy(),

    // Entity classes
    ProcessingJob: asValue(ProcessingJob),
    ProcessingItem: asValue(ProcessingItem),
    ProcessingPipeline: asValue(ProcessingPipeline),
  })
}
```

---

## Faza 3 — Built-in Providers

### 3.1 `providers/ai-transform.provider.ts`

Najwazniejszy provider. Generyczny AI z prompt template + structured output.

```typescript
import type { StepProvider, StepProviderInput, StepProviderResult } from '../lib/types'
```

**Implementacja**:
- Resolve model z `providerConfig.model` lub default (`process.env.AI_DEFAULT_MODEL || 'claude-sonnet-4-5-20250514 or appropriate model'`)
- Interpoluj `{{field}}` w `providerConfig.prompt` z `itemData`
- Zbuduj Zod schema z `providerConfig.outputSchema` (dynamicznie: `{ key: "string" }` → `z.object({ key: z.string() })`)
- Wywolaj `generateObject` z AI SDK
- Zwroc `{ status: 'success', data: result.object }`

**Edge cases**:
- Brak `prompt` w config → `{ status: 'error', error: 'Missing prompt in providerConfig' }`
- Brak `outputSchema` → uzyj `generateText` zamiast `generateObject`, zwroc `{ text: result.text }`
- AI rate limit → throw (engine retry policy obsluzy)
- Template `{{field}}` z undefined wartoscia → zamien na empty string, nie crashuj
- Nested template `{{nested.field}}` → resolve dot-notation
- `outputSchema` z nieznanym typem → fallback na `z.string()`

Mapowanie `outputSchema` types na Zod:
| JSON type | Zod |
|-----------|-----|
| `"string"` | `z.string()` |
| `"number"` | `z.number()` |
| `"boolean"` | `z.boolean()` |
| `"array"` | `z.array(z.unknown())` |
| inne | `z.string()` (fallback) |

### 3.2 `providers/ai-translate.provider.ts`

**Implementacja**:
- `providerConfig.fields`: string[] — ktore pola tlumaczyc
- `providerConfig.targetLang`: string — jezyk docelowy
- `providerConfig.sourceLang`: string (optional, default 'auto')
- Dla kazdego pola: `generateText` z promptem "Translate the following text to {targetLang}. Return only the translation, nothing else: {value}"
- Output: `{ field_targetLang: translatedValue }` np. `{ description_pl: "..." }`

**Edge cases**:
- Pole nie istnieje w itemData → skip, nie dodawaj do output
- Pole jest empty string → skip
- Pole nie jest stringiem → `String(value)` przed tlumaczeniem
- `fields` empty array → zwroc `{ status: 'success', data: {} }` (no-op)
- `targetLang` brak → `{ status: 'error', error: 'Missing targetLang' }`

### 3.3 `providers/schema-validate.provider.ts`

**Implementacja**:
- `providerConfig.schema`: object z definicjami pol
- Zbuduj Zod schema dynamicznie (jak ai-transform)
- Waliduj `itemData` przez schema
- Success → `{ status: 'success', data: { valid: true } }`
- Failure → `{ status: 'error', error: 'Validation failed', data: { valid: false, errors: [...] } }`

**Edge case**: Provider zwraca `status: 'error'` ale to NIE jest blad przetwarzania — to wynik walidacji. Engine powinien traktowac to per step.optional: jesli optional → kontynuuj (item nie failed, ale ma bledy walidacji w step_results).

### 3.4 `providers/http-webhook.provider.ts`

**Implementacja**:
- `providerConfig.url`: string (wymagany)
- `providerConfig.method`: 'GET' | 'POST' | 'PUT' (default 'POST')
- `providerConfig.headers`: Record<string, string>
- `providerConfig.bodyTemplate`: Record<string, unknown>
- `providerConfig.responseMapping`: Record<string, string>
- `providerConfig.timeout`: number (default 10000)

- Interpoluj `{{field}}` w url, headers, bodyTemplate z itemData
- Interpoluj `{{env.VAR}}` z `process.env`
- Wykonaj fetch z AbortController (timeout)
- Parse response JSON
- Apply responseMapping (dot-notation paths) do output data

**Edge cases**:
- Non-2xx response → `{ status: 'error', error: 'HTTP ${status}: ${body}' }`
- Response not JSON → `{ status: 'error', error: 'Response is not JSON' }`
- Timeout → `{ status: 'error', error: 'Request timed out after Xms' }`
- `{{env.VAR}}` nie istnieje → empty string (NIE throw — moze byc opcjonalny header)
- URL template injection → escape only values, nie caly URL (user jest trusted — to ich config)
- SSRF protection: NIE filtrujemy URL — to server-side config od admina, nie user input

---

## Faza 4 — API Routes

### 4.1 `api/openapi.ts`

```typescript
import { createCrudOpenApiFactory } from '@open-mercato/shared/lib/openapi/crud'

export const buildItemProcessingOpenApi = createCrudOpenApiFactory({
  defaultTag: 'ItemProcessing',
})
```

### 4.2 Wzorzec route

Kazdy route exportuje:
- `metadata` z `requireAuth: true` i `requireFeatures`
- `openApi` z tags i summary
- Handler function (GET/POST/PUT/DELETE)

Uzywa:
- `getAuthFromRequest(req)` do auth
- `readJsonSafe(req)` do body parsing
- `createRequestContainer()` do DI
- Zod `.safeParse()` do walidacji input

**API routes do zaimplementowania**:

| File | Methods | Auth Features |
|------|---------|---------------|
| `api/jobs/route.ts` | GET (list), POST (create) | view / run |
| `api/jobs/[id]/route.ts` | GET (detail) | view |
| `api/jobs/[id]/start/route.ts` | POST | run |
| `api/jobs/[id]/cancel/route.ts` | POST | run |
| `api/jobs/[id]/retry/route.ts` | POST | run |
| `api/jobs/[id]/items/route.ts` | GET (list items) | view |
| `api/jobs/[id]/items/[itemId]/review/route.ts` | PUT | review |
| `api/jobs/[id]/review/submit/route.ts` | POST (bulk + resume) | review |
| `api/pipelines/route.ts` | GET (list), POST (create) | view / configure |
| `api/pipelines/[id]/route.ts` | GET (detail), PUT (update) | view / configure |
| `api/providers/route.ts` | GET (list) | view |

**Edge cases API**:
- POST create job z `autoStart: true` → create + enqueue w jednym uzyciu (zwroc `{ id, status: 'pending' }`)
- GET items z filtrem `?status=awaiting_review` — konieczne do UI review
- PUT review na item ktory NIE jest `awaiting_review` → 409 Conflict
- POST bulk review z itemami z roznych jobow → 422 (wszystkie musza byc z tego samego joba)
- POST start na job ktory juz jest `running` → 409
- POST retry na job ktory nie jest `failed` → 409
- GET list jobs z paginacja: `?page=1&pageSize=50&status=paused`
- Pipeline not found (by key) during job create → 404

---

## Faza 5 — Worker + Events + Subscriber

### 5.1 `workers/run-job.ts`

```typescript
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'

type RunJobPayload = {
  jobId: string
  scope: { organizationId: string; tenantId: string; userId?: string | null }
}

export const metadata: WorkerMeta = {
  queue: 'item-processing-run',
  id: 'item-processing:run-job',
  concurrency: 5,
}

export default async function handle(job: QueuedJob<RunJobPayload>, ctx): Promise<void> {
  const engine = ctx.resolve('itemProcessingEngine')
  await engine.runJob(job.payload.jobId, job.payload.scope)
  // Engine handles all error cases internally (marks job as failed)
  // If engine throws → worker marks job as failed in catch block
}
```

**Edge case**: Worker crash mid-processing → job stays `running` forever. Rozwiazanie: ProgressService ma stale timeout (60s). UI moze pokazac "stale" job i pozwolic na cancel/retry.

### 5.2 `subscribers/job-completed-webhook.ts`

```typescript
export const metadata = {
  event: 'item_processing.job.completed',
  persistent: true,
  id: 'item-processing:job-completed-webhook',
}

export default async function handler(payload, ctx) {
  const em = ctx.resolve('em').fork()
  const job = await em.findOne(ProcessingJob, {
    id: payload.jobId,
    tenantId: payload.tenantId,
  })
  if (!job) return

  // Load pipeline to check webhookUrl
  const pipeline = await em.findOne(ProcessingPipeline, { id: job.pipelineId })
  if (!pipeline?.webhookUrl) return

  // Load items for payload
  const items = await em.find(ProcessingItem, { jobId: job.id })

  // POST to webhook
  await fetch(pipeline.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'item_processing.job.completed',
      jobId: job.id,
      pipelineKey: pipeline.pipelineKey,
      resultSummary: job.resultSummary,
      items: items.map(i => ({
        id: i.id,
        inputData: i.inputData,
        outputData: i.outputData,
        selectedValues: i.selectedValues,
        status: i.status,
      })),
    }),
    signal: AbortSignal.timeout(10000),
  })
}
```

**Edge cases**:
- Webhook URL returns non-2xx → log warning, nie throw (persistent subscriber bedzie retryowal)
- Webhook URL nieosiagalny → timeout 10s, persistent retry
- Pipeline deleted po job completion → webhookUrl null → skip

---

## Faza 6 — AI Tools + Widget Injection

### 6.1 `ai-tools.ts`

4 tooly MCP. Pattern z `inbox_ops/ai-tools.ts`:

```typescript
import { z } from 'zod'

type ToolContext = {
  tenantId: string | null
  organizationId: string | null
  userId: string | null
  container: unknown
  userFeatures: string[]
}

export const aiTools = [
  {
    name: 'item_processing_create_job',
    description: 'Create a new item processing job. Provide a pipeline key and array of items to process. Returns the job ID. Use item_processing_get_job to check progress.',
    inputSchema: z.object({
      pipelineKey: z.string().describe('Pipeline configuration key'),
      items: z.array(z.record(z.unknown())).describe('Array of items to process'),
      name: z.string().optional().describe('Optional job name'),
      autoStart: z.boolean().optional().default(true),
    }),
    requiredFeatures: ['item_processing.run'],
    handler: async (input, ctx) => { /* resolve services, create job, optionally enqueue */ },
  },
  {
    name: 'item_processing_get_job',
    description: 'Get the status and items of a processing job. Returns job status, current step, item count, and all items with their step results and suggestions.',
    inputSchema: z.object({
      jobId: z.string().uuid(),
      includeItems: z.boolean().optional().default(true),
    }),
    requiredFeatures: ['item_processing.view'],
    handler: async (input, ctx) => { /* load job + items */ },
  },
  {
    name: 'item_processing_submit_review',
    description: 'Submit review selections for items that are awaiting review. Each selection maps an item ID to the chosen value. Resumes the job after submission.',
    inputSchema: z.object({
      jobId: z.string().uuid(),
      selections: z.array(z.object({
        itemId: z.string().uuid(),
        selectedValue: z.record(z.unknown()),
      })),
    }),
    requiredFeatures: ['item_processing.review'],
    handler: async (input, ctx) => { /* save selections, resume */ },
  },
  {
    name: 'item_processing_list_pipelines',
    description: 'List available processing pipelines with their step definitions.',
    inputSchema: z.object({}),
    requiredFeatures: ['item_processing.view'],
    handler: async (input, ctx) => { /* list pipelines */ },
  },
]
```

### 6.2 `widgets/injection/ProcessItemsAction.tsx`

Headless bulk action widget:

```typescript
// widget.ts (headless — no React component)
export const metadata = {
  id: 'item_processing.bulk.process_items',
  title: 'Process Items',
}

export const menuItems = [
  {
    id: 'item-processing-process-items',
    labelKey: 'item_processing.actions.process_items',
    icon: 'lucide:play',
    action: 'navigate',
    href: '/backend/item-processing/jobs/create',
  },
]
```

### 6.3 `widgets/injection-table.ts`

```typescript
export const injectionTable = {
  'data-table:catalog-products:bulk-actions': [
    { widgetId: 'item_processing.bulk.process_items', priority: 90 },
  ],
}

export default injectionTable
```

---

## Faza 6b — Agent-in-the-Loop (Tier 3)

Nowy typ kroku `agent_review` — AI agent autonomicznie podejmuje decyzje z confidence thresholds i eskalacja do czlowieka.

### 6b.1 Rozszerzenie typow (`lib/types.ts`)

Dodaj do istniejacego pliku:

```typescript
export interface AgentReviewConfig {
  prompt: string
  autoApproveThreshold: number       // 0-100
  escalateToHumanBelow: number       // 0-100
  includeStepResults: boolean
  includeSuggestions: boolean
  strategy: 'pick_best' | 'pick_if_confident' | 'always_escalate' | 'custom'
  maxAutoApprovals?: number
  outputSchema?: Record<string, string>
}

export interface AgentReviewResult {
  decidedBy: 'agent' | 'human' | 'agent_escalated_to_human'
  agentConfidence: number
  agentReasoning: string
  agentSelectedSuggestionId: string | null
  agentNotes: string | null
  humanOverride: boolean
  humanSelectedSuggestionId: string | null
  finalDecision: 'auto_approved' | 'escalated' | 'spot_check' | 'human_override'
  decidedAt: string
}
```

Rozszerzenie `PipelineStepDefinition.type`:
```typescript
type: 'automated' | 'review' | 'agent_review'
agentConfig?: AgentReviewConfig  // wymagane gdy type === 'agent_review'
```

### 6b.2 `lib/agent-reviewer.ts`

Serce agent-in-the-loop. Uzywa AI SDK `generateObject`.

```typescript
import { generateObject } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'

export function createAgentReviewer() {
  return {
    async reviewItem(input: AgentReviewInput): Promise<AgentReviewOutput>
  }
}

interface AgentReviewInput {
  item: ProcessingItem
  agentConfig: AgentReviewConfig
  pipelineContext: {
    pipelineName: string
    stepKey: string
    previousSteps: string[]
  }
}

interface AgentReviewOutput {
  selectedSuggestionId: string | null
  selectedValue: Record<string, unknown> | null
  confidence: number
  reasoning: string
  needsHumanReview: boolean
  notes: string | null
}
```

**Algorytm `reviewItem`**:

```
1. Zbuduj kontekst dla AI:
   - item.input_data (opis produktu, ilosc, wartosci)
   - item.output_data (accumulated — np. przetlumaczony opis)
   - item.step_results z poprzednich krokow (suggestions z ISZTAR4 itd.)
   - agentConfig.prompt (instrukcje decyzyjne)

2. Zbuduj system prompt:
   "You are an expert reviewer evaluating batch processing results.
    You must analyze the item data and previous step results,
    then make a decision.

    PIPELINE: {pipelineName}
    STEP: {stepKey}
    PREVIOUS STEPS COMPLETED: {previousSteps}

    YOUR TASK:
    {agentConfig.prompt}

    ITEM DATA:
    {JSON.stringify(item.input_data)}

    ENRICHED DATA:
    {JSON.stringify(item.output_data)}

    PREVIOUS STEP RESULTS:
    {JSON.stringify(item.step_results)}  // jesli includeStepResults

    AVAILABLE SUGGESTIONS:
    {formatSuggestions(suggestions)}  // jesli includeSuggestions

    Make your decision. Be precise about your confidence level."

3. Call generateObject z outputSchema:
   z.object({
     selectedSuggestionId: z.string().nullable(),
     selectedValue: z.record(z.unknown()).nullable(),
     confidence: z.number().min(0).max(100),
     reasoning: z.string(),
     needsHumanReview: z.boolean(),
     notes: z.string().nullable(),
   })

4. Apply strategy modifiers:
   - 'pick_best': jesli suggestions istnieja, agent MUSI wybrac jedna
   - 'pick_if_confident': agent moze zwrocic null jesli nie jest pewny
   - 'always_escalate': force needsHumanReview = true (agent daje rekomendacje, nie decyzje)
   - 'custom': bez modyfikacji (full agent freedom)

5. Return output
```

**Edge cases agent reviewer**:
- AI SDK rate limit → throw, engine retryPolicy obsluzy
- AI zwraca selectedSuggestionId ktory nie istnieje w suggestions → log warning, treat as needsHumanReview
- AI zwraca confidence > 100 lub < 0 → clamp do 0-100
- AI timeout → default timeout 30s, throw on timeout
- Brak suggestions z poprzednich krokow a agent ma wybierac → agent moze zwrocic custom selectedValue (nie musi wybierac z listy)
- `maxAutoApprovals` exceeded → force escalation niezaleznie od confidence
- Prompt injection through item data → AI SDK ma guardrails; dodatkowo truncate item data do 5000 chars

### 6b.3 Integracja z processing-engine.ts

Nowy branch w petli krokow:

```
if step.type === 'agent_review':
  - Resolve agentReviewer (z DI)
  - Track autoApprovalCount = 0

  - For each item (pending/completed from prior steps):
    i.  Call agentReviewer.reviewItem(item, step.agentConfig)

    ii. Apply decision rules:
        - confidence >= autoApproveThreshold AND !needsHumanReview
          AND autoApprovalCount < maxAutoApprovals:
          → Auto-approve: save selectedValue, set step_results[stepKey] = AgentReviewResult
          → Mark item: status stays in pipeline (continues to next step)
          → autoApprovalCount++
          → Emit: item.agent_decided

        - confidence < escalateToHumanBelow OR needsHumanReview
          OR autoApprovalCount >= maxAutoApprovals:
          → Escalate: mark item 'awaiting_review'
          → Save agent recommendation in step_results (human sees it as pre-fill)
          → Emit: item.agent_escalated

        - Between thresholds:
          → Auto-approve but flag: step_results[stepKey].flaggedForReview = true
          → autoApprovalCount++
          → Emit: item.agent_decided

  - After all items processed:
    - If ANY items are 'awaiting_review':
      → Set job status → 'paused'
      → Emit: job.paused_for_review
      → STOP (human reviews escalated items)
    - If ALL items auto-approved:
      → Continue to next step (no pause)
      → Emit: job.step_completed

  - On resumeAfterReview():
    → Human submitted reviews for escalated items
    → Mark in step_results: humanOverride = (human chose different than agent)
    → Continue pipeline
```

**Kluczowy UX**: gdy job pauzuje na agent_review z eskalowanymi itemami, UI pokazuje:
- "AI reviewed 45/50 items automatically"
- "5 items need your attention (AI was not confident)"
- Per eskalowany item: "AI recommends: {suggestion} (68% confidence) — {reasoning}"
- User moze kliknac "Accept AI recommendation" lub wybrac inny

### 6b.4 Walidacja w validators.ts

Dodaj:

```typescript
export const agentReviewConfigSchema = z.object({
  prompt: z.string().min(10).max(5000),
  autoApproveThreshold: z.number().min(0).max(100),
  escalateToHumanBelow: z.number().min(0).max(100),
  includeStepResults: z.boolean().default(true),
  includeSuggestions: z.boolean().default(true),
  strategy: z.enum(['pick_best', 'pick_if_confident', 'always_escalate', 'custom']),
  maxAutoApprovals: z.number().int().min(1).max(100000).optional(),
  outputSchema: z.record(z.string()).optional(),
}).refine(
  (data) => data.escalateToHumanBelow <= data.autoApproveThreshold,
  { message: 'escalateToHumanBelow must be <= autoApproveThreshold' }
)
```

Rozszerzenie pipelineStepSchema:
```typescript
// dodaj do pipelineStepSchema:
agentConfig: agentReviewConfigSchema.optional(),

// refine: agentConfig required when type === 'agent_review'
```

---

## Faza 6c — AI Pipeline Designer (Tier 4)

### 6c.1 `lib/pipeline-designer.ts`

AI generuje pipeline config z opisu w jezyku naturalnym.

```typescript
export function createPipelineDesigner() {
  return {
    async designPipeline(input: DesignPipelineInput): Promise<DesignPipelineOutput>
  }
}

interface DesignPipelineInput {
  description: string
  itemSample?: Record<string, unknown>  // przykladowy item (opcjonalny)
  availableProviders: StepProvider[]     // co jest dostepne
  preferences?: {
    includeAgentReview: boolean
    includeHumanReview: boolean
    maxSteps: number
  }
}

interface DesignPipelineOutput {
  pipelineKey: string
  name: string
  description: string
  steps: PipelineStepDefinition[]
  reasoning: string  // dlaczego taki uklad krokow
}
```

**Algorytm**:

```
1. Zbierz kontekst:
   - Lista dostepnych providerow (z registry): name, category, description
   - Przykladowy item (jesli podany)
   - Preferencje uzytkownika

2. System prompt:
   "You are a pipeline architect for a batch item processing system.
    
    Available step providers:
    {providers.map(p => `- ${p.providerKey}: ${p.displayName} (${p.category}) — ${p.description}`)}
    
    Available step types:
    - automated: runs a provider on each item
    - review: pauses for human review
    - agent_review: AI agent reviews with confidence thresholds

    Design a pipeline for:
    {description}

    Sample item: {itemSample}

    Return a complete pipeline configuration."

3. generateObject z schema odpowiadajacym PipelineStepDefinition[]

4. Walidacja wygenerowanego pipeline:
   - Unique stepKeys
   - providerKey istnieje w registry
   - agentConfig poprawny jesli agent_review
   
5. Return
```

### 6c.2 MCP Tool

```typescript
{
  name: 'item_processing_design_pipeline',
  description: 'Design a processing pipeline from a natural language description. Analyzes available providers and creates an optimal step configuration. Returns the pipeline definition ready to be created.',
  inputSchema: z.object({
    description: z.string().describe('What needs to be processed and how'),
    itemSample: z.record(z.unknown()).optional().describe('Example item for context'),
    includeAgentReview: z.boolean().optional().default(true),
    includeHumanReview: z.boolean().optional().default(true),
  }),
  requiredFeatures: ['item_processing.configure'],
  handler: async (input, ctx) => {
    const designer = ctx.container.resolve('itemProcessingPipelineDesigner')
    const providers = getAllStepProviders()
    return designer.designPipeline({
      description: input.description,
      itemSample: input.itemSample,
      availableProviders: providers,
      preferences: {
        includeAgentReview: input.includeAgentReview,
        includeHumanReview: input.includeHumanReview,
        maxSteps: 10,
      },
    })
  },
}
```

**Edge cases**:
- AI generuje providerKey ktory nie istnieje → filtruj, zamien na `ai_transform` z odpowiednim promptem
- AI generuje > maxSteps → truncate z warning
- AI generuje pipeline bez review step → dodaj warning ale nie blokuj (moze byc intended)
- Brak dostepnych providerow → zwroc pipeline z samymi ai_transform + review

---

## Faza 6d — Anomaly Detection (Tier 5)

### 6d.1 `lib/anomaly-detector.ts`

Analizuje wyniki jobow po zakonczeniu.

```typescript
export function createAnomalyDetector() {
  return {
    async analyzeJob(jobId: string, scope: TenantScope): Promise<AnomalyReport>
  }
}

interface AnomalyReport {
  anomalies: Anomaly[]
  summary: {
    totalItems: number
    anomalousItems: number
    severity: 'none' | 'low' | 'medium' | 'high'
  }
}

interface Anomaly {
  type: 'inconsistent_classification' | 'outlier_confidence' | 'agent_human_disagreement' | 'duplicate_items'
  severity: 'low' | 'medium' | 'high'
  affectedItemIds: string[]
  description: string
  details: Record<string, unknown>
}
```

**Typy anomalii**:

| Typ | Opis | Detekcja |
|-----|------|----------|
| `inconsistent_classification` | Podobne itemy sklasyfikowane inaczej | Porownaj input similarity (opis) vs output similarity (wybrany kod). Jesli input similar ale output rozny → anomalia. |
| `outlier_confidence` | Item z drastycznie innym confidence niz reszta | Standard deviation na confidence. Items > 2 stddev od mean → outlier. |
| `agent_human_disagreement` | Agent i czlowiek wybrali rozne opcje | Porownaj agentSelectedSuggestionId vs humanSelectedSuggestionId w AgentReviewResult. |
| `duplicate_items` | Identyczne lub prawie identyczne itemy | Hash input_data, grupuj duplikaty. |

**Implementacja simplyfikowana** (na hackathon):
- Uzyj AI (generateObject) do analizy wynikow zamiast implementowac algorytmy statystyczne
- Prompt: "Analyze these processing results for anomalies and inconsistencies"
- Input: summary of all items z ich wynikami
- AI zwraca strukturyzowany raport

### 6d.2 `subscribers/job-anomaly-detection.ts`

```typescript
export const metadata = {
  event: 'item_processing.job.completed',
  persistent: true,
  id: 'item-processing:anomaly-detection',
}

export default async function handler(payload, ctx) {
  const detector = ctx.resolve('itemProcessingAnomalyDetector')
  const jobService = ctx.resolve('itemProcessingJobService')
  
  const report = await detector.analyzeJob(payload.jobId, {
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
  })

  if (report.anomalies.length > 0) {
    // Zapisz raport w job.result_summary.anomalies
    await jobService.updateResultSummary(payload.jobId, {
      anomalies: report,
    }, { tenantId: payload.tenantId, organizationId: payload.organizationId })
  }
}
```

---

## Faza 7 — UI

### 7.1 Job list page (`backend/item-processing/page.tsx`)

- `page.meta.ts`: `requireAuth: true, requireFeatures: ['item_processing.view']`
- DataTable z kolumnami: Name, Pipeline, Status (badge), Progress (x/y), Current Step, Created, Actions
- Row actions: View, Cancel (jesli running/paused), Retry (jesli failed)
- Przycisk "New Job" → navigate do create page
- Filter by status, sort by created_at desc

### 7.2 Job create page (`backend/item-processing/jobs/create/page.tsx`)

- Select pipeline z dropdown (GET /api/item_processing/pipelines)
- Textarea / JSON editor do wklejenia items (jako JSON array)
- Alternatywnie: upload CSV/JSON file
- Przycisk "Create & Start"
- POST /api/item_processing/jobs z `autoStart: true`
- Redirect do job detail page

### 7.3 Job detail page (`backend/item-processing/jobs/[id]/page.tsx`)

Najwazniejsza strona. Trzy sekcje:

**Header**: Job name, status badge, pipeline name, progress bar, timestamps

**Items table**: DataTable z kolumnami:
- Index, Input (summary), Status (per-item badge), Current Step
- Per-step result columns (dynamicznie z pipeline steps)
- Expandable row: pelne input_data, output_data, step_results, suggestions

**Review panel** (widoczny gdy job.status === 'paused'):
- Dla kazdego item z status 'awaiting_review':
  - Pokaz suggestions jako radio/select list
  - User wybiera → PUT per item review
- Przycisk "Submit All Reviews & Continue" → POST bulk submit

**Edge cases UI**:
- SSE updates: `useAppEvent('item_processing.job.step_completed')` → refresh data
- Job cancelled while user reviews → show "Job was cancelled" toast
- Empty suggestions (provider zwrocil `needs_review` bez suggestions) → show freeform input
- Very long item list (1000+) → pagination na items table

### 7.4 Pipeline config page (`backend/item-processing/pipelines/page.tsx`)

- Lista pipelines (DataTable)
- Create/edit pipeline w dialogu
- JSON editor dla steps array
- Walidacja real-time (steps unique keys, providerKey required for automated)

---

## Faza 8 — Demo Provider (ISZTAR4)

### 8.1 ISZTAR4 API client

**Endpoint**: `https://ext-isztar4.mf.gov.pl/taryfa_celna/api/...`

Dedykowany `StepProvider`:

```typescript
const isztarHsProvider: StepProvider = {
  providerKey: 'isztar_hs_classification',
  displayName: 'ISZTAR4 HS Code Classification',
  category: 'classification',

  async processItem(input) {
    const description = String(input.itemData.description || input.itemData.description_pl || '')
    if (!description.trim()) {
      return { status: 'error', error: 'No description available for HS classification' }
    }

    const results = await queryIsztar4(description)

    if (results.length === 0) {
      return { status: 'needs_review', suggestions: [], confidence: 0 }
    }

    return {
      status: 'needs_review',
      suggestions: results.map((r, i) => ({
        id: r.code,
        label: `${r.code} — ${r.description}`,
        description: r.fullPath,
        value: { hsCode: r.code, hsDescription: r.description },
        confidence: Math.max(0, 100 - i * 15), // malejacy confidence
      })),
      confidence: results[0] ? 85 : 0,
    }
  },
}
```

**Edge cases ISZTAR4**:
- API niedostepne → throw (engine retry obsluzy)
- API zwraca puste wyniki → `needs_review` z pustymi suggestions (user wpisuje recznie)
- Opis jest po angielsku → step `ai_translate` przed `isztar_hs_classification` w pipeline
- Opis jest bardzo dlugi → truncate do 200 chars dla query
- Znaki specjalne w opisie → URL encode

### 8.2 Pipeline template w seedDefaults

```typescript
{
  pipelineKey: 'customs_hs_classification',
  name: 'HS Code Classification (Customs)',
  steps: [
    {
      stepKey: 'translate',
      label: 'Translate to Polish',
      type: 'automated',
      providerKey: 'ai_translate',
      providerConfig: { targetLang: 'pl', fields: ['description'] },
      outputMapping: { description_pl: 'description_pl' },
      optional: true,
    },
    {
      stepKey: 'classify_hs',
      label: 'HS Code Classification',
      type: 'automated',
      providerKey: 'isztar_hs_classification',
      inputMapping: { description: 'description_pl' },
    },
    {
      stepKey: 'ai_fallback',
      label: 'AI Fallback Classification',
      type: 'automated',
      providerKey: 'ai_transform',
      providerConfig: {
        prompt: 'Suggest the most likely HS tariff codes for: {{description}}. Return top 3 codes with descriptions.',
        outputSchema: { suggestions: 'array' },
      },
      condition: { field: 'classify_hs.confidence', op: 'lt', value: 50 },
      optional: true,
    },
    {
      stepKey: 'review',
      label: 'Review HS Codes',
      type: 'review',
    },
  ],
}
```

### 8.3 i18n

`i18n/en.json` i `i18n/pl.json` z kluczami:
- `item_processing.title`
- `item_processing.jobs.title`, `.create`, `.detail`
- `item_processing.pipelines.title`
- `item_processing.status.*` (pending, running, paused, completed, failed, cancelled)
- `item_processing.actions.*` (start, cancel, retry, submit_review, process_items)

---

## Faza 9 — Finalizacja

1. Dodaj `{ id: 'item_processing', from: '@open-mercato/core' }` do `apps/mercato/src/modules.ts`
2. `yarn generate` (modules:prepare)
3. `yarn build` — upewnij sie ze calosc sie kompiluje
4. `yarn lint` — popraw ewentualne bledy
5. Przetestuj end-to-end flow:
   - Utworz pipeline
   - Utworz job z itemami
   - Start → observe progress
   - Review → submit selections
   - Verify completed job z wynikami

---

## Podsumowanie zlozonosci

| Komponent | Pliki | Zlozonosc |
|-----------|-------|-----------|
| Scaffold (index, acl, events, setup) | 4 | Niska — kopiuj wzorce |
| Entities + validators | 2 | Srednia — 3 encje, duzo Zod |
| Types | 1 | Niska — interfejsy |
| Provider registry | 1 | Niska — Map wrapper |
| Condition evaluator | 1 | Niska — parser warunkow |
| Job service | 1 | Srednia — CRUD + status machine |
| Pipeline service | 1 | Niska — CRUD + walidacja |
| Processing engine | 1 | **Wysoka** — glowna logika + agent_review |
| DI | 1 | Niska — Awilix wiring |
| Built-in providers (4x) | 4 | Srednia — AI SDK + HTTP |
| Agent reviewer | 1 | **Wysoka** — AI decision engine |
| Pipeline designer | 1 | Srednia — AI generates config |
| Anomaly detector | 1 | Srednia — AI analysis |
| API routes (11x) | 11 | Srednia — boilerplate |
| Worker | 1 | Niska |
| Subscribers (2x) | 2 | Niska-srednia |
| AI tools (6x) | 1 | Srednia |
| Widget injection | 2 | Niska |
| UI pages (4x) | 4+ | Srednia-wysoka |
| Demo provider (ISZTAR4) | 1 | Srednia |
| i18n | 2 | Niska |
| **TOTAL** | ~45 plikow | |

**5 tier AI architecture**:
1. AI as Step Provider (ai_transform, ai_translate) — AI robi prace
2. AI Tools / MCP (6 narzedzi) — AI agent operuje pipeline'ami
3. Agent-in-the-Loop (agent_review step) — AI podejmuje decyzje z eskalacja
4. AI Pipeline Designer — AI projektuje pipeline'y z opisu
5. AI Anomaly Detection — AI analizuje wyniki i wykrywa niespojnosci

**Krytyczna sciezka**: entities → engine → agent-reviewer → API routes → worker → UI detail page z review + agent recommendations
