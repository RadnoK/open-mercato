# WS-1: Foundation

**Kto**: Osoba A + B razem
**Branch**: `feature/item-processing`
**Czas**: ~1h
**Zalezy od**: nic

---

## Cel

Scaffold modulu + data layer. Po tym workstreamie modul istnieje w systemie, ma encje w DB i typy zdefiniowane. Obie osoby moga potem pracowac niezaleznie.

## Pliki do stworzenia

### 1. `index.ts` — Module metadata

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

### 2. `acl.ts` — RBAC features

```typescript
export const features = [
  { id: 'item_processing.view', title: 'View processing jobs and results', module: 'item_processing' },
  { id: 'item_processing.run', title: 'Create and run processing jobs', module: 'item_processing' },
  { id: 'item_processing.review', title: 'Submit review selections', module: 'item_processing' },
  { id: 'item_processing.configure', title: 'Manage pipeline configurations', module: 'item_processing' },
]

export default features
```

### 3. `events.ts` — Typed events

Pelna lista wlacznie z agent events (zeby nie trzeba bylo mergowac pozniej):

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
  { id: 'item_processing.item.agent_decided', label: 'Agent Made Decision', entity: 'item', category: 'lifecycle' },
  { id: 'item_processing.item.agent_escalated', label: 'Agent Escalated to Human', entity: 'item', category: 'lifecycle', clientBroadcast: true },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'item_processing', events })
export const emitItemProcessingEvent = eventsConfig.emit
export type ItemProcessingEventId = typeof events[number]['id']
export default eventsConfig
```

### 4. `lib/types.ts` — Wszystkie interfejsy

Pelna lista wlacznie z AgentReviewConfig (zeby Osoba A nie musial mergowac pozniej):

- `StepProvider`, `StepProviderInput`, `StepProviderResult`, `StepSuggestion`, `StepProviderValidation`
- `TenantScope`
- `StepCondition`
- `PipelineStepDefinition` (z `type: 'automated' | 'review' | 'agent_review'` i `agentConfig?`)
- `AgentReviewConfig`, `AgentReviewResult`

Dokladne definicje: patrz `.ai/plans/item-processing-implementation.md` Faza 1.6 i Faza 6b.1.

### 5. `data/entities.ts` — 3 encje MikroORM

- `ProcessingPipeline` (table: `processing_pipelines`)
- `ProcessingJob` (table: `processing_jobs`)
- `ProcessingItem` (table: `processing_items`)

Dokladne kolumny: patrz `.ai/plans/item-processing-implementation.md` Faza 1.4.

### 6. `data/validators.ts` — Zod schemas

Wszystkie schemas wlacznie z `agentReviewConfigSchema`:

- `stepConditionSchema`
- `agentReviewConfigSchema` (z refine: escalateToHumanBelow <= autoApproveThreshold)
- `pipelineStepSchema` (z agentConfig optional, refine: required when type === 'agent_review')
- `createPipelineSchema`, `updatePipelineSchema`
- `createJobSchema`
- `submitItemReviewSchema`, `bulkSubmitReviewSchema`

Dokladne definicje: patrz `.ai/plans/item-processing-implementation.md` Faza 1.5 i Faza 6b.4.

### 7. `setup.ts` — Stub (uzupelnimy w WS-6)

```typescript
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['item_processing.*'],
    employee: ['item_processing.view', 'item_processing.run', 'item_processing.review'],
  },
}

export default setup
```

### 8. `di.ts` — Stub (uzupelnimy w WS-6)

```typescript
import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { ProcessingJob, ProcessingItem, ProcessingPipeline } from './data/entities'

export function register(container: AppContainer) {
  container.register({
    ProcessingJob: asValue(ProcessingJob),
    ProcessingItem: asValue(ProcessingItem),
    ProcessingPipeline: asValue(ProcessingPipeline),
  })
}
```

### 9. Migracja

```bash
yarn db:generate
```

### 10. Aktywacja (tymczasowa)

Dodaj do `apps/mercato/src/modules.ts`:
```typescript
{ id: 'item_processing', from: '@open-mercato/core' },
```

### 11. Verify

```bash
yarn generate
yarn build
```

## Definition of Done

- [ ] Modul widoczny w systemie (`yarn generate` przechodzi)
- [ ] Tabele w DB istnieja (migracja wygenerowana)
- [ ] `yarn build` przechodzi bez bledow
- [ ] Obie osoby moga branchowac z tego stanu
