# WS-3: API Routes + Worker + UI

**Kto**: Osoba B
**Branch**: `feature/ip-api-ui`
**Czas**: ~8h
**Zalezy od**: WS-1

---

## Cel

Caly surface layer: API routes, queue worker, webhook subscriber, backend UI pages. Po tym workstreamie mamy dzialajacy HTTP API i UI — nawet jesli engine jeszcze nie jest gotowy, API poprawnie tworzy/listuje joby i pipeline'y, a UI je wyswietla.

## Strategia niezaleznosci od engine

Osoba B pracuje z serwisami przez interfejsy (types.ts z WS-1). Dopoki engine nie jest zmergowany:
- API routes do CRUD (list, create, get) dzialaja bezposrednio na EntityManager
- Routes ktore triggeruja engine (start, retry, resume) → enqueuuja do queue i zwracaja 202 Accepted
- Worker wywoluje `engine.runJob()` — jesli engine nie istnieje, placeholder throw
- UI laduje dane z API — nie zalezy od engine

Po merge WS-2: worker i action routes zaczynaja dzialac e2e.

---

## Pliki do stworzenia

### 1. `api/openapi.ts`

```typescript
import { createCrudOpenApiFactory } from '@open-mercato/shared/lib/openapi/crud'

export const buildItemProcessingOpenApi = createCrudOpenApiFactory({
  defaultTag: 'ItemProcessing',
})
```

### 2. API Routes — Jobs

#### `api/jobs/route.ts` — GET list + POST create

**GET** `/api/item_processing/jobs`
- Auth: `item_processing.view`
- Query params: `?page=1&pageSize=50&status=paused&pipelineId=uuid`
- Response: `{ items: ProcessingJob[], total, page, pageSize }`
- Sort: `created_at DESC`

**POST** `/api/item_processing/jobs`
- Auth: `item_processing.run`
- Body: `createJobSchema` (pipelineKey, items, name?, sourceType?, sourceId?, autoStart?)
- Logic:
  1. Resolve pipeline by pipelineKey
  2. Create job (status: 'pending') + items (bulk insert)
  3. Snapshot pipeline.steps into job.config
  4. If autoStart → enqueue to `item-processing-run` queue
  5. Response: `{ id, status, totalItems, progressJobId? }` 201

#### `api/jobs/[id]/route.ts` — GET detail

- Auth: `item_processing.view`
- Response: job + pipeline info + item summary counts

#### `api/jobs/[id]/start/route.ts` — POST

- Auth: `item_processing.run`
- Assert job.status === 'pending'
- Create ProgressJob, set job.progress_job_id
- Enqueue to `item-processing-run` queue
- Response: `{ id, status: 'pending', progressJobId }` 202

#### `api/jobs/[id]/cancel/route.ts` — POST

- Auth: `item_processing.run`
- Assert job.status in ['pending', 'running', 'paused']
- If running → `progressService.cancelJob(progressJobId)` (engine checks on next item)
- If pending/paused → directly set status 'cancelled'
- Response: `{ id, status: 'cancelled' }` 200

#### `api/jobs/[id]/retry/route.ts` — POST

- Auth: `item_processing.run`
- Assert job.status in ['failed', 'completed'] AND failed_items > 0
- Reset failed items, enqueue
- Response: `{ id, status: 'pending' }` 202

### 3. API Routes — Items + Review

#### `api/jobs/[id]/items/route.ts` — GET

- Auth: `item_processing.view`
- Query: `?status=awaiting_review&page=1&pageSize=100`
- Response: `{ items: ProcessingItem[], total }`

#### `api/jobs/[id]/items/[itemId]/review/route.ts` — PUT

- Auth: `item_processing.review`
- Body: `submitItemReviewSchema` (`{ selectedValue: {...} }`)
- Assert: item.status === 'awaiting_review'
- Save `selected_values[currentStepKey] = selectedValue`
- Response: `{ id, status: 'completed_review' }` (item status stays awaiting until bulk submit)

**Edge case**: PUT na item ktory nie jest `awaiting_review` → 409 Conflict

#### `api/jobs/[id]/review/submit/route.ts` — POST

- Auth: `item_processing.review`
- Body: `bulkSubmitReviewSchema` (`{ selections: [{itemId, selectedValue}], resume: true }`)
- For each selection: save selected_values
- If resume === true: enqueue job resume (engine.resumeAfterReview)
- Response: `{ submitted: N, resumed: boolean }` 200

**Edge cases**:
- Selections z itemami z innego joba → 422
- Job nie jest 'paused' a resume=true → 409
- Puste selections → 422

### 4. API Routes — Pipelines

#### `api/pipelines/route.ts` — GET list + POST create

**GET** `/api/item_processing/pipelines`
- Auth: `item_processing.view`
- Response: all active pipelines for tenant

**POST** `/api/item_processing/pipelines`
- Auth: `item_processing.configure`
- Body: `createPipelineSchema`
- Validation: unique stepKeys, providerKey required for automated, agentConfig for agent_review
- Response: created pipeline 201

#### `api/pipelines/[id]/route.ts` — GET + PUT

- GET: detail z steps
- PUT: `updatePipelineSchema`
- Auth: configure

### 5. API Routes — Providers

#### `api/providers/route.ts` — GET

- Auth: `item_processing.view`
- Response: `getAllStepProviders().map(p => ({ providerKey, displayName, category, description }))`

### 6. `workers/run-job.ts`

```typescript
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'

type RunJobPayload = {
  jobId: string
  action: 'run' | 'resume' | 'retry'
  scope: { organizationId: string; tenantId: string; userId?: string | null }
}

export const metadata: WorkerMeta = {
  queue: 'item-processing-run',
  id: 'item-processing:run-job',
  concurrency: 5,
}

export default async function handle(job: QueuedJob<RunJobPayload>, ctx): Promise<void> {
  const engine = ctx.resolve('itemProcessingEngine')
  const { jobId, action, scope } = job.payload

  try {
    if (action === 'run') await engine.runJob(jobId, scope)
    else if (action === 'resume') await engine.resumeAfterReview(jobId, scope)
    else if (action === 'retry') await engine.retryFailedItems(jobId, scope)
  } catch (error) {
    // Finalize job as failed if engine throws
    const jobService = ctx.resolve('itemProcessingJobService')
    const progressService = ctx.resolve('progressService')
    const run = await jobService.getJob(jobId, scope)
    if (run && !['completed', 'failed', 'cancelled'].includes(run.status)) {
      await jobService.updateStatus(jobId, 'failed', scope, error.message)
      if (run.progressJobId) {
        await progressService.failJob(run.progressJobId, { errorMessage: error.message }, scope)
      }
    }
    throw error
  }
}
```

**Kluczowe**: Payload ma pole `action` ktore mowi co worker ma zrobic. Jeden queue, jeden worker, 3 akcje.

### 7. `subscribers/job-completed-webhook.ts`

```typescript
export const metadata = {
  event: 'item_processing.job.completed',
  persistent: true,
  id: 'item-processing:job-completed-webhook',
}

export default async function handler(payload, ctx) {
  const em = ctx.resolve('em').fork()
  const job = await em.findOne(ProcessingJob, { id: payload.jobId, tenantId: payload.tenantId })
  if (!job) return

  const pipeline = await em.findOne(ProcessingPipeline, { id: job.pipelineId })
  if (!pipeline?.webhookUrl) return

  const items = await em.find(ProcessingItem, { jobId: job.id })

  try {
    await fetch(pipeline.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'item_processing.job.completed',
        jobId: job.id,
        pipelineKey: pipeline.pipelineKey,
        resultSummary: job.resultSummary,
        items: items.map(i => ({
          id: i.id, inputData: i.inputData, outputData: i.outputData,
          selectedValues: i.selectedValues, status: i.status,
        })),
      }),
      signal: AbortSignal.timeout(10000),
    })
  } catch (err) {
    console.warn('[item-processing] Webhook delivery failed:', err)
    // Persistent subscriber will retry
  }
}
```

### 8. Backend UI Pages

#### `backend/item-processing/page.meta.ts`

```typescript
export const metadata = {
  requireAuth: true,
  requireFeatures: ['item_processing.view'],
  pageTitle: 'Item Processing',
  pageTitleKey: 'item_processing.title',
  pageOrder: 80,
}
```

#### `backend/item-processing/page.tsx` — Job list

- DataTable z kolumnami: Name, Pipeline, Status (badge), Progress (processed/total), Current Step, Created At
- Row actions: View, Cancel (if running/paused), Retry (if failed)
- "New Job" button → `/backend/item-processing/jobs/create`
- Filter dropdown: status (all, pending, running, paused, completed, failed)
- Auto-refresh via `useAppEvent('item_processing.job.step_completed')` / `job.completed` / `job.failed`

#### `backend/item-processing/jobs/create/page.tsx`

- Pipeline selector (dropdown, loaded from GET /api/item_processing/pipelines)
- Items input: JSON textarea (paste array of objects)
- Optional: name field
- "Create & Start" button
- POST /api/item_processing/jobs z autoStart: true
- On success → navigate to `/backend/item-processing/jobs/{id}`

#### `backend/item-processing/jobs/[id]/page.tsx` — GLOWNA STRONA

**Header section**:
- Job name, status badge (color-coded), pipeline name
- Progress bar (processed/total)
- Timestamps: created, started, completed
- Action buttons: Cancel (if running/paused), Retry (if failed)

**Items table** (DataTable):
- Columns: #, Description (from input_data), Status, Current Step
- Expandable row: full input_data, output_data, step_results per step
- Filter: status dropdown
- Pagination (pageSize: 50)

**Review panel** (visible when job.status === 'paused'):
- Header: "X items need review"
- For each item with status 'awaiting_review':
  - Show input summary
  - Show suggestions as selectable list (radio buttons)
  - If agent_review step provided recommendation:
    - Pre-select agent's choice
    - Show: "AI recommends: {label} ({confidence}%) — {reasoning}"
    - Badge: "AI suggestion" or "AI escalated"
  - Selected value stored locally
- "Submit All Reviews" button → POST bulk submit
- After submit: auto-refresh (job resumes, status changes)

**SSE integration**:
- `useAppEvent('item_processing.job.step_completed')` → refetch job data
- `useAppEvent('item_processing.job.paused_for_review')` → show review panel
- `useAppEvent('item_processing.job.completed')` → show completion
- `useAppEvent('item_processing.item.agent_escalated')` → update item badge

**Edge cases UI**:
- Job cancelled while reviewing → toast "Job was cancelled"
- Empty suggestions → freeform JSON input for selectedValue
- 1000+ items → pagination (never load all at once)
- Agent review results → show "Auto-approved by AI" badge vs "Needs your review"

#### `backend/item-processing/pipelines/page.tsx`

- DataTable: pipeline name, key, steps count, active status
- Create dialog: name, key, description, steps (JSON editor)
- Edit: same dialog, pre-filled
- Toggle active/inactive

### 9. `lib/queue.ts` — Queue helper

```typescript
import { createQueue } from '@open-mercato/queue'

const QUEUE_NAME = 'item-processing-run'

export function getItemProcessingQueue() {
  const strategy = process.env.QUEUE_STRATEGY === 'async' ? 'async' : 'local'
  return createQueue(QUEUE_NAME, strategy)
}
```

Used by API routes to enqueue jobs.

## Definition of Done

- [ ] All 11 API routes respond correctly (manual test with curl/Postman)
- [ ] Worker processes queue jobs (calls engine methods)
- [ ] Webhook subscriber fires on job.completed (mock webhook URL)
- [ ] Job list page shows jobs with status badges
- [ ] Job create page creates job and redirects to detail
- [ ] Job detail page shows items, step results, review panel
- [ ] Pipeline page lists/creates/edits pipelines
- [ ] Review flow works end-to-end in UI (submit + resume)
- [ ] `yarn build` passes on branch
