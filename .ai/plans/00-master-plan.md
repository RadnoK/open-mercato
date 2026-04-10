# Master Plan: modul `item_processing`

**Data**: 2026-04-10
**Zespol**: 2 osoby (Osoba A + Osoba B)
**Lokalizacja**: `packages/core/src/modules/item_processing/`
**Spec**: `.ai/specs/2026-04-10-item-processing-module.md`
**Szczegolowy plan implementacji**: `.ai/plans/item-processing-implementation.md`

---

## Strategia podzialu pracy

Projekt dzieli sie na **7 workstreamow** + **2 moduły**:
- **Core module** (`packages/core/src/modules/item_processing/`) — generyczny, reużywalny
- **Showcase app** (`apps/mercato/src/modules/customs_clearance/`) — demo customs clearance

Dwie osoby pracuja na osobnych branchach. **Osoba A skupia sie na core module**, **Osoba B na showcase + integracji**.

### Graf zaleznosci

```
WS-1: Foundation (SHARED — robimy razem)
  │
  ├──────────────────────────┐
  │                          │
  v                          v
WS-2: Processing Engine    WS-7: Showcase — Customs Clearance
(Osoba A — core module)    (Osoba B — app module)
  │                          │
  v                          │ (czeka na engine dla ISZTAR4+pipeline)
WS-3: API + Worker + UI     │
(Osoba A — core module)      │
  │                          │
  v                          v
WS-4: AI Brain             WS-7 cont: ISZTAR4 + UI
(Osoba A — core module)    (Osoba B — app module)
  │                          │
  v                          │
WS-5: Built-in Providers   │
(Osoba A — core module)      │
  │                          │
  └──────────┬───────────────┘
             v
WS-6: Integration + Finalizacja (SHARED)
```

### Przypisanie

| Workstream | Osoba | Branch | Zalezy od |
|-----------|-------|--------|-----------|
| WS-1: Foundation | A+B razem | `feature/item-processing` | — |
| WS-2: Processing Engine | Osoba A | `feature/ip-engine` | WS-1 |
| WS-3: API + Worker + UI | Osoba A | `feature/ip-api-ui` | WS-2 |
| WS-4: AI Brain | Osoba A | `feature/ip-ai-brain` | WS-2 |
| WS-5: Built-in Providers | Osoba A | `feature/ip-providers` | WS-2 |
| WS-6: Integration | A+B razem | `feature/item-processing` | WS-4 + WS-5 + WS-7 |
| WS-7: Customs Showcase | Osoba B | `feature/customs-showcase` | WS-1 (scaffold), WS-2 (ISZTAR4 pipeline) |

### Logika podzialu

**Osoba A** (core module — `packages/core/src/modules/item_processing/`):
- WS-2: Processing engine, job service, pipeline service, condition evaluator
- WS-3: API routes, worker, subscriber, generic UI pages
- WS-4: Agent reviewer, pipeline designer, anomaly detector
- WS-5: Built-in providers (ai_transform, ai_translate, schema_validate, http_webhook), MCP tools

**Osoba B** (showcase app — `apps/mercato/src/modules/customs_clearance/`):
- WS-7: Document parsing (OCR + AI), consistency verification, ISZTAR4 provider, customs-specific UI, orchestration service

**Dlaczego ten podzial dziala**:
- WS-2 i WS-3 nie dotykaja tych samych plikow (engine vs routes/pages)
- WS-4 i WS-5 nie dotykaja tych samych plikow (lib/agent-*.ts vs providers/*.ts + api/*.ts)
- Jedyny shared file to `di.ts` — mergujemy go na koncu w WS-6
- Osoba B moze mockować engine w API (zwracac hardcoded responses) do czasu merge
- Osoba A moze testowac engine unit testami bez API

---

## Harmonogram (szacunkowy)

```
Czas    Osoba A                          Osoba B
─────   ──────────────────────────────   ──────────────────────────────
T+0     ┌─── WS-1: Foundation (razem) ─────────────────────────────┐
T+1h    └──────────────────────────────────────────────────────────┘

T+1h    WS-2: Processing Engine          WS-3: API routes + UI
T+2h    ├── types.ts                     ├── openapi.ts
T+3h    ├── provider-registry.ts         ├── jobs/route.ts (list+create)
T+4h    ├── condition-evaluator.ts       ├── jobs/[id]/*.ts (all actions)
T+5h    ├── job-service.ts               ├── items + review routes
T+6h    ├── pipeline-service.ts          ├── pipelines + providers routes
T+7h    ├── processing-engine.ts         ├── workers/run-job.ts
T+8h    └── (testy manualne engine)      ├── subscribers/webhook.ts
T+9h                                     └── UI pages (list, create, detail)

T+9h    ── MERGE WS-2 + WS-3 → feature/item-processing ──

T+9h    WS-4: AI Brain                   WS-5: Providers + Demo
T+10h   ├── agent-reviewer.ts            ├── ai-transform.provider.ts
T+11h   ├── engine integration           ├── ai-translate.provider.ts
T+12h   ├── pipeline-designer.ts         ├── schema-validate.provider.ts
T+13h   ├── anomaly-detector.ts          ├── http-webhook.provider.ts
T+14h   └── subscriber anomaly           ├── ISZTAR4 provider
T+15h                                    ├── ai-tools.ts (MCP)
T+16h                                    └── widget injection

T+16h   ── MERGE WS-4 + WS-5 → feature/item-processing ──

T+16h   ┌─── WS-6: Integration + Finalizacja (razem) ─────────────┐
T+17h   ├── di.ts (merge all services)
T+18h   ├── setup.ts (pipeline templates)
T+19h   ├── modules.ts activation + yarn generate
T+20h   ├── yarn build + lint
T+21h   ├── end-to-end test
T+22h   └── demo prep
        └──────────────────────────────────────────────────────────┘
```

---

## Plany szczegolowe

Kazdy workstream ma osobny plan:

| Plan | Plik | Opis |
|------|------|------|
| WS-1 | `.ai/plans/01-foundation.md` | Scaffold, entities, validators, types — robimy razem |
| WS-2 | `.ai/plans/02-processing-engine.md` | Core engine, services, condition evaluator |
| WS-3 | `.ai/plans/03-api-worker-ui.md` | API routes, worker, subscriber, UI pages |
| WS-4 | `.ai/plans/04-ai-brain.md` | Agent reviewer, pipeline designer, anomaly detector |
| WS-5 | `.ai/plans/05-providers-demo.md` | Built-in providers, ISZTAR4, MCP tools, widgets |
| WS-6 | `.ai/plans/06-integration.md` | DI merge, setup, activation, testing, demo |

---

## Kontrakt miedzy workstreamami

### WS-2 ↔ WS-3: Engine ↔ API

Osoba B (API) importuje z Osoby A (engine) przez interfejsy:

```typescript
// Osoba B uzywa tych funkcji (Osoba A implementuje):
type JobService = {
  createJob(input, scope): Promise<ProcessingJob>
  getJob(jobId, scope): Promise<ProcessingJob | null>
  listJobs(filters, scope): Promise<{ items: ProcessingJob[]; total: number }>
  updateStatus(jobId, status, scope, error?): Promise<ProcessingJob | null>
}

type PipelineService = {
  createPipeline(input, scope): Promise<ProcessingPipeline>
  getPipelineByKey(key, scope): Promise<ProcessingPipeline | null>
  listPipelines(scope): Promise<ProcessingPipeline[]>
  updatePipeline(id, input, scope): Promise<ProcessingPipeline | null>
}

type ProcessingEngine = {
  runJob(jobId, scope): Promise<void>
  resumeAfterReview(jobId, scope): Promise<void>
  retryFailedItems(jobId, scope): Promise<void>
}
```

**Zanim engine jest gotowy**: Osoba B moze:
- Implementowac API routes ktore robia CRUD bezposrednio na entity (em.find/em.persist)
- Worker ktory wywoluje `engine.runJob()` — gdy engine nie istnieje, po prostu loguje
- UI ktore laduje dane z API — nie zalezy od engine

### WS-4 ↔ WS-2: AI Brain ↔ Engine

Osoba A rozszerza swoj wlasny engine o `agent_review` step type:

```typescript
// Nowy serwis w DI:
type AgentReviewer = {
  reviewItem(input: AgentReviewInput): Promise<AgentReviewOutput>
}

// Engine dodaje branch:
if (step.type === 'agent_review') {
  const reviewer = deps.agentReviewer
  // ... agent review logic
}
```

### WS-5 ↔ WS-2: Providers ↔ Engine

Provider registry jest czescia WS-2 (Osoba A). Osoba B rejestruje providery:

```typescript
// Osoba B implementuje providery ktore spelniaja interfejs:
interface StepProvider {
  readonly providerKey: string
  processItem(input: StepProviderInput): Promise<StepProviderResult>
}

// Rejestracja w di.ts (WS-6):
registerStepProvider(aiTransformProvider)
```

---

## Merge strategy

1. **WS-1** → commit bezposrednio na `feature/item-processing`
2. **WS-2** → branch `feature/ip-engine`, PR do `feature/item-processing`
3. **WS-3** → branch `feature/ip-api-ui`, PR do `feature/item-processing`
4. Merge WS-2 + WS-3 (resolve conflicts w `di.ts` jesli sa)
5. **WS-4** → branch `feature/ip-ai-brain`, PR do `feature/item-processing`
6. **WS-5** → branch `feature/ip-providers`, PR do `feature/item-processing`
7. Merge WS-4 + WS-5
8. **WS-6** → bezposrednio na `feature/item-processing`
9. Final PR: `feature/item-processing` → `main`

---

## Krytyczne pliki — kto co posiada

| Plik | Wlasciciel | Notatka |
|------|-----------|---------|
| `index.ts` | WS-1 (shared) | Nie zmieniaj po WS-1 |
| `acl.ts` | WS-1 (shared) | Nie zmieniaj po WS-1 |
| `events.ts` | WS-1 (shared) | Osoba A dodaje agent events w WS-4 |
| `data/entities.ts` | WS-1 (shared) | Nie zmieniaj po WS-1 |
| `data/validators.ts` | WS-1 (shared) | Osoba A rozszerza o agentReviewConfigSchema w WS-4 |
| `lib/types.ts` | Osoba A | Osoba A dodaje AgentReviewConfig w WS-4 |
| `lib/provider-registry.ts` | Osoba A | |
| `lib/condition-evaluator.ts` | Osoba A | |
| `lib/job-service.ts` | Osoba A | |
| `lib/pipeline-service.ts` | Osoba A | |
| `lib/processing-engine.ts` | Osoba A | |
| `lib/agent-reviewer.ts` | Osoba A | |
| `lib/pipeline-designer.ts` | Osoba A | |
| `lib/anomaly-detector.ts` | Osoba A | |
| `providers/*.ts` | Osoba B | |
| `api/**/*.ts` | Osoba B | |
| `workers/*.ts` | Osoba B | |
| `subscribers/*.ts` | Osoba B | anomaly subscriber: Osoba A |
| `backend/**/*.tsx` | Osoba B | |
| `ai-tools.ts` | Osoba B | Osoba A dodaje design_pipeline tool w WS-4 |
| `widgets/**` | Osoba B | |
| `di.ts` | WS-6 (shared) | Merge na koncu |
| `setup.ts` | WS-6 (shared) | Merge na koncu |
| `i18n/*.json` | WS-6 (shared) | Merge na koncu |
