# WS-6: Integration + Finalizacja

**Kto**: Osoba A + B razem
**Branch**: `feature/item-processing` (po merge WS-4 + WS-5)
**Czas**: ~3h
**Zalezy od**: WS-4 + WS-5

---

## Cel

Zlaczyc wszystkie workstreamy: DI wiring, setup z pipeline templates, i18n, aktywacja modulu, weryfikacja e2e.

## Kolejnosc

### 1. Merge branches

```bash
# Na feature/item-processing (po WS-1):
git merge feature/ip-engine      # WS-2
git merge feature/ip-api-ui      # WS-3
# Resolve conflicts (glownie di.ts)
git merge feature/ip-ai-brain    # WS-4
git merge feature/ip-providers   # WS-5
# Resolve conflicts (di.ts, ai-tools.ts)
```

**Spodziewane konflikty**:
- `di.ts` — kazdy WS dodal swoje rejestracje, trzeba polaczyc
- `ai-tools.ts` — WS-5 stworzyl plik, WS-4 dodaje design_pipeline tool
- `events.ts` — nie powinno byc konfliktow (wszystko w WS-1)

### 2. `di.ts` — Final merge

Polaczony plik ze wszystkimi rejestracjami:

```typescript
import { asFunction, asValue } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { ProgressService } from '../progress/lib/progressService'

// Entities
import { ProcessingJob, ProcessingItem, ProcessingPipeline } from './data/entities'

// Services
import { createJobService } from './lib/job-service'
import { createPipelineService } from './lib/pipeline-service'
import { createProcessingEngine } from './lib/processing-engine'
import { createAgentReviewer } from './lib/agent-reviewer'
import { createPipelineDesigner } from './lib/pipeline-designer'
import { createAnomalyDetector } from './lib/anomaly-detector'

// Provider registry + built-in providers
import { registerStepProvider } from './lib/provider-registry'
import { aiTransformProvider } from './providers/ai-transform.provider'
import { aiTranslateProvider } from './providers/ai-translate.provider'
import { schemaValidateProvider } from './providers/schema-validate.provider'
import { httpWebhookProvider } from './providers/http-webhook.provider'
import { isztarHsProvider } from './providers/isztar-hs.provider'

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
  registerStepProvider(isztarHsProvider)

  container.register({
    // Entity classes
    ProcessingJob: asValue(ProcessingJob),
    ProcessingItem: asValue(ProcessingItem),
    ProcessingPipeline: asValue(ProcessingPipeline),

    // Core services
    itemProcessingJobService: asFunction(({ em }: Cradle) =>
      createJobService(em)
    ).scoped().proxy(),

    itemProcessingPipelineService: asFunction(({ em }: Cradle) =>
      createPipelineService(em)
    ).scoped().proxy(),

    // AI services
    itemProcessingAgentReviewer: asFunction(() =>
      createAgentReviewer()
    ).scoped().proxy(),

    itemProcessingPipelineDesigner: asFunction(() =>
      createPipelineDesigner()
    ).scoped().proxy(),

    itemProcessingAnomalyDetector: asFunction(() =>
      createAnomalyDetector()
    ).scoped().proxy(),

    // Engine (depends on job service + agent reviewer)
    itemProcessingEngine: asFunction(({
      em, itemProcessingJobService, progressService, itemProcessingAgentReviewer,
    }: Cradle & {
      itemProcessingJobService: ReturnType<typeof createJobService>
      itemProcessingAgentReviewer: ReturnType<typeof createAgentReviewer>
    }) =>
      createProcessingEngine({
        em,
        jobService: itemProcessingJobService,
        progressService,
        agentReviewer: itemProcessingAgentReviewer,
      })
    ).scoped().proxy(),
  })
}
```

### 3. `setup.ts` — Pipeline templates

```typescript
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ProcessingPipeline } from './data/entities'

const PIPELINE_TEMPLATES = [
  {
    pipelineKey: 'customs_hs_classification',
    name: 'HS Code Classification (Customs)',
    description: 'Translate product descriptions, classify via ISZTAR4, AI agent review with human escalation',
    steps: [
      {
        stepKey: 'translate', label: 'Translate to Polish', type: 'automated',
        providerKey: 'ai_translate',
        providerConfig: { targetLang: 'pl', fields: ['description'] },
        outputMapping: { description_pl: 'description_pl' },
        optional: true,
      },
      {
        stepKey: 'classify_hs', label: 'HS Code Classification', type: 'automated',
        providerKey: 'isztar_hs_classification',
        inputMapping: { description: 'description_pl' },
      },
      {
        stepKey: 'agent_review', label: 'AI Agent Review', type: 'agent_review',
        agentConfig: {
          prompt: 'Review the HS code classification. Select the most appropriate code. Escalate if ambiguous.',
          autoApproveThreshold: 85, escalateToHumanBelow: 50,
          includeStepResults: true, includeSuggestions: true,
          strategy: 'pick_if_confident', maxAutoApprovals: 100,
        },
      },
      {
        stepKey: 'human_review', label: 'Human Review (escalated only)', type: 'review',
        condition: { field: 'agent_review.finalDecision', op: 'eq', value: 'escalated' },
      },
    ],
  },
  {
    pipelineKey: 'product_data_validation',
    name: 'Product Data Quality Check',
    description: 'Validate product data schema and review errors',
    steps: [
      {
        stepKey: 'validate', label: 'Validate Schema', type: 'automated',
        providerKey: 'schema_validate',
        providerConfig: { schema: { name: { type: 'string', required: true, minLength: 1 }, quantity: { type: 'number', required: true, min: 0 } } },
      },
      { stepKey: 'review_errors', label: 'Review Validation Errors', type: 'review' },
    ],
  },
  {
    pipelineKey: 'generic_ai_enrichment',
    name: 'Generic AI Enrichment',
    description: 'Process items with AI transform and review results',
    steps: [
      {
        stepKey: 'transform', label: 'AI Transform', type: 'automated',
        providerKey: 'ai_transform',
        providerConfig: { prompt: 'Analyze this item and extract key attributes: {{description}}', outputSchema: { category: 'string', tags: 'array', summary: 'string' } },
      },
      { stepKey: 'review', label: 'Review Results', type: 'review' },
    ],
  },
]

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['item_processing.*'],
    employee: ['item_processing.view', 'item_processing.run', 'item_processing.review'],
  },

  async seedDefaults({ em, tenantId, organizationId }) {
    for (const template of PIPELINE_TEMPLATES) {
      const existing = await em.findOne(ProcessingPipeline, {
        pipelineKey: template.pipelineKey,
        tenantId,
        organizationId,
        deletedAt: null,
      })
      if (!existing) {
        const pipeline = em.create(ProcessingPipeline, {
          pipelineKey: template.pipelineKey,
          name: template.name,
          description: template.description,
          steps: template.steps,
          isActive: true,
          organizationId,
          tenantId,
        })
        em.persist(pipeline)
      }
    }
    await em.flush()
  },
}

export default setup
```

### 4. `i18n/en.json`

```json
{
  "item_processing.title": "Item Processing",
  "item_processing.jobs.title": "Processing Jobs",
  "item_processing.jobs.create": "New Job",
  "item_processing.jobs.detail": "Job Detail",
  "item_processing.pipelines.title": "Pipelines",
  "item_processing.status.pending": "Pending",
  "item_processing.status.running": "Running",
  "item_processing.status.paused": "Paused for Review",
  "item_processing.status.completed": "Completed",
  "item_processing.status.failed": "Failed",
  "item_processing.status.cancelled": "Cancelled",
  "item_processing.actions.start": "Start",
  "item_processing.actions.cancel": "Cancel",
  "item_processing.actions.retry": "Retry",
  "item_processing.actions.submit_review": "Submit Reviews",
  "item_processing.actions.process_items": "Process Items",
  "item_processing.review.agent_recommends": "AI recommends",
  "item_processing.review.agent_confidence": "confidence",
  "item_processing.review.auto_approved": "Auto-approved by AI",
  "item_processing.review.escalated": "Escalated to you",
  "item_processing.review.human_override": "You overrode AI",
  "item_processing.anomalies.title": "Anomaly Report"
}
```

### 5. `i18n/pl.json`

```json
{
  "item_processing.title": "Przetwarzanie pozycji",
  "item_processing.jobs.title": "Zadania przetwarzania",
  "item_processing.jobs.create": "Nowe zadanie",
  "item_processing.jobs.detail": "Szczegoly zadania",
  "item_processing.pipelines.title": "Pipeline'y",
  "item_processing.status.pending": "Oczekuje",
  "item_processing.status.running": "W trakcie",
  "item_processing.status.paused": "Oczekuje na review",
  "item_processing.status.completed": "Zakonczone",
  "item_processing.status.failed": "Blad",
  "item_processing.status.cancelled": "Anulowane",
  "item_processing.actions.start": "Uruchom",
  "item_processing.actions.cancel": "Anuluj",
  "item_processing.actions.retry": "Ponow",
  "item_processing.actions.submit_review": "Zatwierdz wybory",
  "item_processing.actions.process_items": "Przetwarzaj pozycje",
  "item_processing.review.agent_recommends": "AI rekomenduje",
  "item_processing.review.agent_confidence": "pewnosc",
  "item_processing.review.auto_approved": "Zaakceptowane przez AI",
  "item_processing.review.escalated": "Eskalowane do Ciebie",
  "item_processing.review.human_override": "Nadpisales decyzje AI",
  "item_processing.anomalies.title": "Raport anomalii"
}
```

### 6. Aktywacja + Generate

Upewnij sie ze `apps/mercato/src/modules.ts` ma:
```typescript
{ id: 'item_processing', from: '@open-mercato/core' },
```

```bash
yarn generate
yarn build
yarn lint
```

### 7. End-to-end test

**Scenariusz 1: Prosty pipeline (human review)**
1. Utworz pipeline `product_data_validation` (z seedDefaults)
2. POST create job z 3 itemami: `[{name: "Laptop", quantity: 5}, {name: "", quantity: -1}, {name: "Phone", quantity: 10}]`
3. Start job
4. Step "validate" → item 2 fails validation
5. Job pauses at "review_errors"
6. Submit review → job completes
7. Verify result_summary

**Scenariusz 2: Agent-in-the-loop pipeline**
1. Utworz pipeline `customs_hs_classification` (z seedDefaults)
2. POST create job z 5 itemami (product descriptions)
3. Start job
4. Step "translate" → descriptions translated to Polish
5. Step "classify_hs" → ISZTAR4 returns HS suggestions
6. Step "agent_review" → AI auto-approves 3 (high confidence), escalates 2
7. Job pauses
8. Human reviews 2 escalated items, submits
9. Step "human_review" skipped (conditional — only for escalated, already reviewed)
10. Job completes
11. Verify: agent_review results have decidedBy, confidence, reasoning per item
12. Anomaly detection subscriber fires, report generated

**Scenariusz 3: MCP tools**
1. Call `item_processing_list_pipelines` → see templates
2. Call `item_processing_create_job` → creates + starts
3. Call `item_processing_get_job` → see progress
4. Wait for pause
5. Call `item_processing_submit_review` → resumes

## Definition of Done

- [ ] `di.ts` correctly wires all services and providers
- [ ] `setup.ts` seeds 3 pipeline templates
- [ ] i18n complete (en + pl)
- [ ] Module activated in modules.ts
- [ ] `yarn generate` passes
- [ ] `yarn build` passes
- [ ] `yarn lint` passes
- [ ] E2E scenario 1 works (human review)
- [ ] E2E scenario 2 works (agent review + escalation)
- [ ] E2E scenario 3 works (MCP tools)
- [ ] Demo-ready
