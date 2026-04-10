# WS-2: Processing Engine

**Kto**: Osoba A
**Branch**: `feature/ip-engine`
**Czas**: ~8h
**Zalezy od**: WS-1

---

## Cel

Zaimplementowac core processing engine — serce modulu. Po tym workstreamie mozna: tworzyc joby, uruchamiac pipeline, pausowac na review, resumowac, retryowac failed items. Bez API (to robi Osoba B) — testujemy przez unit testy i reczne wywolania serwisow.

## Pliki do stworzenia

### 1. `lib/provider-registry.ts`

Map-based registry identyczny z `data_sync/lib/adapter-registry.ts`:

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

### 2. `lib/condition-evaluator.ts`

Ewaluacja `StepCondition` na `item.step_results`.

**Eksport**: `evaluateCondition(condition, stepResults) → boolean`

**Algorytm**:
1. `condition` undefined → return `true`
2. Array → AND logic (all must be true). Empty array → `true`
3. Resolve `field` przez dot-notation (`"classify_hs.confidence"` → `stepResults.classify_hs.confidence`)
4. Ewaluuj operator (eq, neq, gt, gte, lt, lte, exists, contains)

**Edge cases**:
- Field nie istnieje → `false`
- Field = `null` → `false` dla porownania, odpowiednio dla `exists`
- Non-numeric value przy gt/lt → `false` (nie crash)
- Deep nested path → iteruj segmenty

### 3. `lib/job-service.ts`

Factory function: `createJobService(em: EntityManager)`

**Metody**:
- `createJob(input, scope)` — tworzy ProcessingJob + ProcessingItems (bulk insert)
- `getJob(jobId, scope)` — findOne z tenant scoping
- `listJobs(filters, scope)` — find z paginacja, filtr status
- `updateStatus(jobId, status, scope, error?)` — z walidacja transitions
- `updateCounters(jobId, delta, scope)` — increment processed/failed/skipped
- `setCurrentStep(jobId, stepKey, scope)`
- `getJobItems(jobId, scope, filters?)` — find items z opcjonalnym filtr status
- `updateItem(itemId, updates, scope)` — update single item
- `updateItemsBulk(jobId, itemUpdates, scope)` — batch update items

**Status transitions walidacja**:

```
pending → running, cancelled
running → paused, completed, failed, cancelled
paused → running, cancelled
failed → pending (retry)
completed, cancelled → (terminal)
```

Jesli transition niedozwolona → throw Error z opisem.

**Edge case — concurrent update**: Uzyj `em.nativeUpdate` z `WHERE status = currentStatus` i sprawdz `affectedRows`. Jesli 0 → job zostal zmieniony przez inny process.

**Edge case — createJob z 10000 items**: Batch insert w chunks po 500 (MikroORM `em.persist` + periodic `em.flush`).

### 4. `lib/pipeline-service.ts`

Factory function: `createPipelineService(em: EntityManager)`

**Metody**:
- `createPipeline(input, scope)` — z walidacja
- `getPipeline(id, scope)`
- `getPipelineByKey(key, scope)`
- `listPipelines(scope)`
- `updatePipeline(id, input, scope)`

**Walidacja przy create/update**:
- `stepKey` unique w ramach steps
- `type === 'automated'` → `providerKey` wymagany
- `type === 'agent_review'` → `agentConfig` wymagany
- `pipelineKey` unique per tenant
- `agentConfig.escalateToHumanBelow <= agentConfig.autoApproveThreshold`

### 5. `lib/processing-engine.ts` — GLOWNY PLIK

Factory function: `createProcessingEngine(deps: EngineDeps)`

**Deps** (z DI):
```typescript
type EngineDeps = {
  em: EntityManager
  jobService: JobService
  progressService: ProgressService
}
```

**Metody**:
- `runJob(jobId, scope)` — glowna petla
- `resumeAfterReview(jobId, scope)` — wznowienie po human/agent review
- `retryFailedItems(jobId, scope)` — reset failed items → re-run

**Algorytm `runJob`** (szczegolowy):

```
1. LOAD JOB
   job = jobService.getJob(jobId, scope)
   Assert: job exists, status in ['pending', 'running']
   pipeline = JSON.parse(job.config)  // snapshot from creation

2. START
   jobService.updateStatus(jobId, 'running', scope)
   progressJob = progressService.createJob({...})
   progressService.startJob(progressJobId, scope)
   Emit: item_processing.job.started

3. RESOLVE START STEP
   startStepIndex = 0
   If job.current_step exists:
     startStepIndex = pipeline.steps.findIndex(s => s.stepKey === job.current_step)
     If not found → startStepIndex = 0

4. STEP LOOP
   For i = startStepIndex; i < pipeline.steps.length; i++:
     step = pipeline.steps[i]
     jobService.setCurrentStep(jobId, step.stepKey, scope)

     4a. CHECK CANCELLATION
         If progressService.isCancellationRequested(progressJobId):
           finalize(jobId, 'cancelled', scope)
           return

     4b. STEP TYPE: 'review'
         Load items where status NOT IN ('failed', 'skipped')
         Set items → status: 'awaiting_review', current_step: step.stepKey
         jobService.updateStatus(jobId, 'paused', scope)
         Emit: item_processing.job.paused_for_review
         return  // STOP — wait for human

     4c. STEP TYPE: 'agent_review'
         (Handled by agent-reviewer, see WS-4)
         Call agentReviewer.processStep(job, step, items, scope)
         If any items escalated to awaiting_review:
           jobService.updateStatus(jobId, 'paused', scope)
           Emit: item_processing.job.paused_for_review
           return  // STOP — wait for human on escalated items
         Else:
           Emit: item_processing.job.step_completed
           continue  // all auto-approved

     4d. STEP TYPE: 'automated'
         provider = getStepProvider(step.providerKey)
         If !provider:
           If step.optional → skip step, continue
           Else → fail job

         Load items (not failed, not skipped on this step)

         For each item (process in chunks of 100):
           4d-i. EVALUATE CONDITION
                 If step.condition defined:
                   result = evaluateCondition(step.condition, item.step_results)
                   If false:
                     item.step_results[step.stepKey] = { status: 'skipped' }
                     jobService.updateCounters(jobId, { skipped: 1 }, scope)
                     continue

           4d-ii. BUILD ITEM DATA
                  itemData = { ...item.input_data, ...item.output_data }
                  If step.inputMapping:
                    mappedData = {}
                    For each [targetKey, sourceKey] in inputMapping:
                      mappedData[targetKey] = resolveDeep(itemData, sourceKey)
                    itemData = { ...itemData, ...mappedData }

           4d-iii. CALL PROVIDER
                   attempt = 0
                   while attempt <= (step.retryPolicy?.maxRetries ?? 0):
                     try:
                       result = await provider.processItem({
                         itemId: item.id,
                         itemIndex: item.itemIndex,
                         itemData,
                         stepConfig: step.providerConfig ?? {},
                         scope
                       })
                       break  // success
                     catch (error):
                       attempt++
                       if attempt > maxRetries:
                         if step.optional:
                           result = { status: 'error', error: error.message }
                           break
                         else:
                           item.status = 'failed'
                           item.errorMessage = error.message
                           jobService.updateCounters(jobId, { failed: 1 }, scope)
                           Emit: item_processing.item.processed
                           continue next item
                       await sleep(backoffMs * attempt)

           4d-iv. SAVE RESULT
                  item.step_results[step.stepKey] = result

                  If step.outputMapping AND result.data:
                    For each [targetKey, sourceKey] in outputMapping:
                      item.output_data[targetKey] = resolveDeep(result.data, sourceKey)
                  Else if result.data:
                    item.output_data = { ...item.output_data, ...result.data }

                  If result.status === 'error' AND !step.optional:
                    item.status = 'failed'
                    item.errorMessage = result.error
                    jobService.updateCounters(jobId, { failed: 1 }, scope)

                  jobService.updateCounters(jobId, { processed: 1 }, scope)
                  progressService.incrementProgress(progressJobId, 1, scope)
                  Emit: item_processing.item.processed

         Emit: item_processing.job.step_completed

5. FINALIZE
   failedCount = count items with status 'failed'
   If failedCount === job.total_items:
     finalize(jobId, 'failed', scope)
   Else:
     Mark remaining non-failed items → 'completed'
     finalize(jobId, 'completed', scope)

HELPER finalize(jobId, status, scope):
  jobService.updateStatus(jobId, status, scope)
  job.completed_at = new Date()
  job.result_summary = buildSummary(items)
  If status === 'completed': progressService.completeJob(...)
  If status === 'failed': progressService.failJob(...)
  If status === 'cancelled': progressService.markCancelled(...)
  Emit: item_processing.job.completed / failed
```

**Algorytm `resumeAfterReview`**:
```
1. Load job (assert status === 'paused')
2. Find current step index in config.steps
3. nextStepIndex = currentStepIndex + 1
4. Items with status 'awaiting_review' that now have selected_values → mark as processed for this step
5. Items with status 'awaiting_review' without selected_values → log warning, skip
6. jobService.updateStatus(jobId, 'running', scope)
7. Continue runJob from nextStepIndex
   (set job.current_step to pipeline.steps[nextStepIndex].stepKey)
   (re-enter step loop from that index)
```

**Algorytm `retryFailedItems`**:
```
1. Load job (assert status in ['failed', 'completed'])
2. Find failed items
3. Reset: status → 'pending', error_message → null, current_step → null
4. Reset job counters: failed_items = 0
5. Determine which step to restart from (first step that has failed items in step_results)
6. jobService.updateStatus(jobId, 'pending', scope)
7. Enqueue job to worker (caller does this, not engine)
```

**Utility functions** (w tym samym pliku lub osobnym `lib/utils.ts`):
- `resolveDeep(obj, dotPath)` — resolve "a.b.c" na obj.a.b.c
- `buildSummary(items)` — aggregate counts
- `sleep(ms)` — Promise-based delay for retry backoff

### 6. Update `di.ts` (local — merge w WS-6)

Osoba A dodaje do swojego brancha:

```typescript
itemProcessingJobService: asFunction(({ em }) => createJobService(em)).scoped().proxy(),
itemProcessingPipelineService: asFunction(({ em }) => createPipelineService(em)).scoped().proxy(),
itemProcessingEngine: asFunction(({ em, itemProcessingJobService, progressService }) =>
  createProcessingEngine({ em, jobService: itemProcessingJobService, progressService })
).scoped().proxy(),
```

## Edge cases — kompletna lista

| Scenariusz | Plik | Obsluga |
|-----------|------|---------|
| Provider nie znaleziony | engine | optional → skip, else fail job |
| Provider throw | engine | retry wg retryPolicy, else fail item |
| Provider returns `{ status: 'error' }` | engine | No retry (intentional), fail item if !optional |
| Provider timeout | provider-level | AbortController 30s, throw → engine retry |
| All items failed | engine | Job status → 'failed' |
| 0 items | job-service | Job completes immediately |
| Cancellation mid-processing | engine | Check isCancellationRequested after each item |
| Concurrent runJob | job-service | Status transition validation rejects |
| Pipeline 0 automated steps | engine | Immediately hits review, pauses |
| Condition references missing step | condition-evaluator | returns false → skip |
| inputMapping missing field | engine | undefined value passed to provider |
| outputMapping on undefined data | engine | Skip mapping, don't overwrite |
| 10000 items | job-service | Batch insert 500, process in chunks 100 |
| Retry on already-completed job | engine | Reset only failed items, re-run from failed step |
| step_results already exists (retry) | engine | Overwrite with new result |
| processBatch available | engine | Use if defined, batch size min(items, 50) |

## Definition of Done

- [ ] `provider-registry.ts` — register/get/getAll works
- [ ] `condition-evaluator.ts` — all operators work, edge cases handled
- [ ] `job-service.ts` — CRUD + status machine + counters
- [ ] `pipeline-service.ts` — CRUD + validation
- [ ] `processing-engine.ts` — runJob/resume/retry complete
- [ ] Engine handles automated + review steps correctly
- [ ] Agent_review step has hook point (throws "not implemented" until WS-4)
- [ ] Status transitions validated
- [ ] `yarn build` passes on branch
