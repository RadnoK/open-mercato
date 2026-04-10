# Item Processing Module — Generic Pipeline for Batch Item Enrichment

**Date**: 2026-04-10
**Status**: Draft
**Module**: `item_processing` (`packages/core/src/modules/item_processing/`)
**Related**: SPEC-040 (Document Parser), data_sync module, workflows module

---

## TLDR

Generic module for processing collections of items through configurable multi-step pipelines with pluggable external API providers, per-item status tracking, and human-in-the-loop review steps. Fills the gap between `data_sync` (entity synchronization) and `workflows` (business process orchestration).

---

## Overview

### Problem Statement

Open Mercato has infrastructure for syncing data between systems (`data_sync`) and orchestrating complex business processes (`workflows`), but lacks a middle-ground primitive: **"take these N items and run them through M processing steps, with external API calls and human review."**

Real-world examples that need this pattern:
- HS code classification via ISZTAR4 API (customs clearance)
- Product categorization via Google Product Taxonomy
- Address validation/normalization via external services
- Sanctions/compliance screening
- Content moderation with AI + human approval
- Lead scoring and CRM contact enrichment
- Tax rate classification across jurisdictions
- Quality assurance checks on imported product data

Each of these follows the same pattern: a batch of items, a series of processing steps (some automated, some requiring human decision), and per-item tracking of progress and results.

### Proposed Solution

A new `item_processing` module providing:

1. **StepProvider Registry** — pluggable adapters for external APIs (same pattern as `DataSyncAdapter`)
2. **Processing Engine** — orchestrates items through pipeline steps with progress tracking
3. **Human-in-the-Loop** — `review` steps pause the pipeline, presenting suggestions for user selection
4. **Pipeline Configuration** — reusable, tenant-scoped pipeline definitions stored as JSON
5. **Per-Item Tracking** — individual status, step results, and error handling per item

---

## Architecture

### System Diagram

```
Any Source (document_parser, CSV, API, manual)
        |
        v
  POST /api/item_processing/jobs
  { pipelineKey, items: [...] }
        |
        v
  ProcessingJob (batch container)
        |
  Pipeline: [step1, step2, ..., stepN]
        |
        v
  ┌──────────────────────────────────────────┐
  │ Processing Engine (lib/processing-engine) │
  │                                          │
  │  for each step in pipeline:              │
  │    if type === 'automated':              │
  │      resolve StepProvider                │
  │      for each pending item:              │
  │        provider.processItem(item)        │
  │        save step_results                 │
  │      emit job.step_completed event       │
  │                                          │
  │    if type === 'review':                 │
  │      set items -> awaiting_review        │
  │      set job -> paused                   │
  │      emit job.paused_for_review event    │
  │      STOP (wait for user)                │
  │                                          │
  │  on resumeAfterReview():                 │
  │    continue from next step               │
  └──────────────────────────────────────────┘
        |
        v
  Output: items with enriched output_data + selected_values
  Event: item_processing.job.completed
```

### Provider Architecture

```
┌─────────────────────────────────────────────┐
│            StepProvider Registry             │
│                                             │
│  registerStepProvider(provider)              │
│  getStepProvider(key) -> provider            │
│  getAllStepProviders() -> provider[]         │
│                                             │
│  Built-in:                                  │
│  ├── ai_translate (AI SDK translation)      │
│  ├── ai_validate (schema-based validation)  │
│  └── passthrough (identity transform)       │
│                                             │
│  External (registered by provider packages):│
│  ├── isztar_hs_classification               │
│  ├── google_product_taxonomy                │
│  ├── smartystreets_address                  │
│  └── ... (any StepProvider implementation)  │
└─────────────────────────────────────────────┘
```

---

## Data Models

### ProcessingPipeline

Table: `processing_pipelines`

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| id | uuid PK | no | |
| organization_id | uuid | no | tenant scoping |
| tenant_id | uuid | no | tenant scoping |
| pipeline_key | text | no | unique per tenant, e.g. `customs_hs_classification` |
| name | text | no | human-readable |
| description | text | yes | |
| steps | jsonb | no | `PipelineStepDefinition[]` |
| is_active | boolean | no | default true |
| created_at | timestamptz | no | |
| updated_at | timestamptz | no | |
| deleted_at | timestamptz | yes | soft delete |
| created_by | uuid | yes | |

**Indexes**: `(tenant_id, organization_id)`, `(tenant_id, pipeline_key)` UNIQUE

### ProcessingJob

Table: `processing_jobs`

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| id | uuid PK | no | |
| organization_id | uuid | no | tenant scoping |
| tenant_id | uuid | no | tenant scoping |
| pipeline_id | uuid FK | no | -> processing_pipelines |
| name | text | yes | |
| status | text | no | `pending / running / paused / completed / failed / cancelled` |
| current_step | text | yes | active step key |
| total_items | int | no | default 0 |
| processed_items | int | no | default 0 |
| failed_items | int | no | default 0 |
| skipped_items | int | no | default 0 |
| progress_job_id | uuid | yes | FK to progress module |
| source_type | text | yes | `manual / document_parser / csv / api` |
| source_id | uuid | yes | optional FK to source record |
| config | jsonb | yes | pipeline config snapshot at creation time |
| result_summary | jsonb | yes | |
| started_at | timestamptz | yes | |
| completed_at | timestamptz | yes | |
| created_by | uuid | yes | |
| created_at | timestamptz | no | |
| updated_at | timestamptz | no | |
| deleted_at | timestamptz | yes | |

**Indexes**: `(tenant_id, organization_id)`, `status`, `pipeline_id`

### ProcessingItem

Table: `processing_items`

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| id | uuid PK | no | |
| job_id | uuid FK | no | -> processing_jobs |
| organization_id | uuid | no | tenant scoping |
| tenant_id | uuid | no | tenant scoping |
| item_index | int | no | position in batch |
| status | text | no | `pending / processing / awaiting_review / completed / failed / skipped` |
| current_step | text | yes | |
| input_data | jsonb | no | original item data |
| output_data | jsonb | yes | accumulated enrichment results |
| step_results | jsonb | yes | per-step results `{ [stepKey]: StepProviderResult }` |
| selected_values | jsonb | yes | user selections from review steps `{ [stepKey]: selection }` |
| error_message | text | yes | |
| created_at | timestamptz | no | |
| updated_at | timestamptz | no | |

**Indexes**: `(job_id)`, `(job_id, status)`, `(tenant_id, organization_id)`

---

## Core Types

### PipelineStepDefinition

```typescript
interface PipelineStepDefinition {
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

### StepCondition (Conditional Steps)

Steps can be conditionally executed based on results from previous steps. If `condition` evaluates to false for an item, the step is skipped for that item (per-item evaluation).

```typescript
interface StepCondition {
  field: string          // JSONPath in step_results, e.g. "classify.confidence"
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'contains'
  value: unknown
}
```

When multiple conditions are provided as an array, they are evaluated with AND logic (all must be true).

**Example**: Run AI fallback only when ISZTAR4 confidence is low:
```json
{
  "stepKey": "ai_fallback",
  "type": "automated",
  "providerKey": "ai_transform",
  "condition": { "field": "classify_hs.confidence", "op": "lt", "value": 70 }
}
```

### StepProvider

```typescript
interface StepProvider {
  readonly providerKey: string
  readonly displayName: string
  readonly category: 'classification' | 'enrichment' | 'validation' | 'transformation'

  processItem(input: StepProviderInput): Promise<StepProviderResult>
  processBatch?(inputs: StepProviderInput[]): Promise<StepProviderResult[]>
  validateConfig?(config: Record<string, unknown>): Promise<{ valid: boolean; message?: string }>
}

interface StepProviderInput {
  itemData: Record<string, unknown>
  stepConfig: Record<string, unknown>
  scope: { organizationId: string; tenantId: string }
}

interface StepProviderResult {
  status: 'success' | 'error' | 'needs_review'
  data?: Record<string, unknown>
  suggestions?: StepSuggestion[]
  confidence?: number
  error?: string
}

interface StepSuggestion {
  id: string
  label: string
  description?: string
  value: Record<string, unknown>
  confidence?: number
  metadata?: Record<string, unknown>
}
```

---

## API Contracts

### Jobs

| Method | Path | Feature | Description |
|--------|------|---------|-------------|
| GET | `/api/item_processing/jobs` | `item_processing.view` | List jobs (paginated, filterable) |
| POST | `/api/item_processing/jobs` | `item_processing.run` | Create job with items + pipeline_key |
| GET | `/api/item_processing/jobs/:id` | `item_processing.view` | Job detail |
| POST | `/api/item_processing/jobs/:id/start` | `item_processing.run` | Start processing |
| POST | `/api/item_processing/jobs/:id/cancel` | `item_processing.run` | Cancel job |
| POST | `/api/item_processing/jobs/:id/retry` | `item_processing.run` | Retry failed items |

### Items & Review

| Method | Path | Feature | Description |
|--------|------|---------|-------------|
| GET | `/api/item_processing/jobs/:id/items` | `item_processing.view` | List items with per-step status |
| PUT | `/api/item_processing/jobs/:id/items/:itemId/review` | `item_processing.review` | Submit review per item |
| POST | `/api/item_processing/jobs/:id/review/submit` | `item_processing.review` | Bulk submit reviews + resume |

### Pipelines & Providers

| Method | Path | Feature | Description |
|--------|------|---------|-------------|
| GET | `/api/item_processing/pipelines` | `item_processing.view` | List pipeline configs |
| POST | `/api/item_processing/pipelines` | `item_processing.configure` | Create pipeline |
| PUT | `/api/item_processing/pipelines/:id` | `item_processing.configure` | Update pipeline |
| GET | `/api/item_processing/providers` | `item_processing.view` | List registered providers |

---

## Events

```typescript
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
```

---

## RBAC Features

| Feature | Description |
|---------|-------------|
| `item_processing.view` | View jobs, items, results, pipelines, providers |
| `item_processing.run` | Create and start jobs, cancel, retry |
| `item_processing.review` | Submit review selections |
| `item_processing.configure` | Create/edit pipeline configurations |

---

## Step Chaining (inputMapping / outputMapping)

The engine builds `itemData` for each step by layering:
1. Start with `item.input_data`
2. Overlay `item.output_data` (accumulated from previous steps)
3. Apply `inputMapping` from step definition (remap fields)
4. Provider result passes through `outputMapping` and merges into `output_data`

**Example**: Translation output feeds into classification input:
```json
[
  {
    "stepKey": "translate",
    "providerKey": "ai_translate",
    "providerConfig": { "targetLang": "pl" },
    "inputMapping": { "text": "description" },
    "outputMapping": { "description_pl": "translatedText" }
  },
  {
    "stepKey": "classify",
    "providerKey": "isztar_hs_classification",
    "inputMapping": { "description": "description_pl" }
  }
]
```

---

## Built-in Providers

The module ships with four providers usable without writing TypeScript code:

### `ai_transform` — Generic AI Provider

Uses AI SDK `generateObject` with a prompt template and output schema.

```typescript
// providerConfig:
{
  "model": "claude-sonnet-4-5-20250514",  // optional, uses default
  "prompt": "Classify this product: {{description}}. Return category and confidence.",
  "outputSchema": {
    "category": "string",
    "confidence": "number",
    "reasoning": "string"
  }
}
```

### `ai_translate` — AI Translation

```typescript
// providerConfig:
{
  "targetLang": "pl",
  "sourceLang": "auto",
  "fields": ["description", "name"]
}
```

Output: `{ description_pl: "...", name_pl: "..." }`

### `schema_validate` — Zod Schema Validation

```typescript
// providerConfig:
{
  "schema": {
    "description": { "type": "string", "required": true, "minLength": 3 },
    "quantity": { "type": "number", "required": true, "min": 0 }
  }
}
```

Returns `success` or `error` with validation messages per field.

### `http_webhook` — Generic HTTP Call

```typescript
// providerConfig:
{
  "url": "https://api.example.com/classify",
  "method": "POST",
  "headers": { "Authorization": "Bearer {{env.API_KEY}}" },
  "bodyTemplate": { "query": "{{description}}", "lang": "pl" },
  "responseMapping": { "code": "result.code", "name": "result.name" },
  "timeout": 10000
}
```

Template interpolation with `{{field}}` from itemData and `{{env.VAR}}` from environment.

---

## Pipeline Templates

Predefined pipeline configurations seeded via `setup.ts` → `seedDefaults()`:

- **HS Code Classification (Customs)**: translate → classify via ISZTAR4 → review
- **Product Data Quality Check**: validate schema → review errors
- **Generic AI Enrichment**: ai_transform → review

Tenants can clone and customize these templates.

---

## Webhook on Job Completion

A persistent event subscriber on `item_processing.job.completed` sends results to an external system if the pipeline configuration includes a `webhookUrl`.

File: `subscribers/job-completed-webhook.ts`

---

## AI-Native Pipeline Features

The module has three tiers of AI integration, making it uniquely powerful compared to traditional batch processing:

### Tier 1: AI as Step Provider (Built-in)

The `ai_transform` and `ai_translate` providers use AI SDK to process items. This is "AI doing work" — translation, classification, extraction, summarization. Already covered in Built-in Providers section.

### Tier 2: AI Tools — Agent Operates Pipelines (MCP)

File: `ai-tools.ts`

| Tool | Description | Feature |
|------|-------------|---------|
| `item_processing_create_job` | Create and optionally start a processing job | `item_processing.run` |
| `item_processing_get_job` | Get job status, items, and step results | `item_processing.view` |
| `item_processing_submit_review` | Submit review selections for items | `item_processing.review` |
| `item_processing_list_pipelines` | List available pipelines with step definitions | `item_processing.view` |
| `item_processing_list_providers` | List available step providers | `item_processing.view` |

This enables AI assistants to operate processing pipelines programmatically via the MCP protocol.

### Tier 3: Agent-in-the-Loop — AI as Autonomous Reviewer

The key innovation: a new step type `agent_review` where an AI agent autonomously evaluates items, makes decisions, and submits reviews — without human intervention (but with full audit trail and configurable guardrails).

#### New Step Type: `agent_review`

```typescript
interface PipelineStepDefinition {
  // ...existing fields...
  type: 'automated' | 'review' | 'agent_review'
  agentConfig?: AgentReviewConfig
}

interface AgentReviewConfig {
  // Decision prompt — what the agent should decide
  prompt: string
  // When to auto-approve vs escalate to human
  autoApproveThreshold: number    // 0-100, agent confidence above this → auto-select
  escalateToHumanBelow: number    // 0-100, below this → pause for human review
  // What the agent sees for context
  includeStepResults: boolean     // show previous step results to agent
  includeSuggestions: boolean     // show provider suggestions to agent
  // Selection strategy
  strategy: 'pick_best' | 'pick_if_confident' | 'always_escalate' | 'custom'
  // Safety: max items agent can auto-approve per job before forced human review
  maxAutoApprovals?: number
  // Custom output schema (agent can add reasoning, notes)
  outputSchema?: Record<string, string>
}
```

#### How It Works

```
Pipeline: [..., classify_hs (automated), agent_review, ...]

For each item at agent_review step:

1. Build context for AI agent:
   - item.input_data (original item)
   - item.output_data (accumulated from prior steps)
   - item.step_results (all provider results + suggestions)
   - agentConfig.prompt (decision instructions)

2. Call AI (generateObject with structured output):
   Prompt: "You are reviewing item classification results.
            Item: {description}
            ISZTAR4 suggestions: [{code: 8471.30, desc: 'Portable computers', confidence: 92}, ...]
            
            {agentConfig.prompt}
            
            Return your decision."
   
   Output schema: {
     selectedSuggestionId: string,  // which suggestion to pick
     confidence: number,            // 0-100 how sure you are
     reasoning: string,             // why this choice
     needsHumanReview: boolean,     // agent can self-escalate
     notes: string                  // additional context
   }

3. Apply decision rules:
   a. If agent.confidence >= autoApproveThreshold AND !needsHumanReview:
      → Auto-select: save selectedValue, mark item 'completed'
      → Record: { decidedBy: 'agent', confidence, reasoning }
   
   b. If agent.confidence < escalateToHumanBelow OR needsHumanReview:
      → Escalate: mark item 'awaiting_review', attach agent recommendation
      → Human sees: "AI recommends: {suggestion} (confidence: {N}%) — {reasoning}"
      → Human can accept AI recommendation or override
   
   c. Between thresholds (escalateToHumanBelow <= confidence < autoApproveThreshold):
      → Auto-select but flag for spot-check
      → Record: { decidedBy: 'agent', flaggedForReview: true }

4. Safety guardrail: if maxAutoApprovals reached:
   → Remaining items escalate to human regardless of confidence
   → Prevents runaway autonomous decisions
```

#### Agent Review Audit Trail

Every agent decision is recorded in `item.step_results[stepKey]`:

```typescript
interface AgentReviewResult {
  decidedBy: 'agent' | 'human' | 'agent_escalated_to_human'
  agentConfidence: number
  agentReasoning: string
  agentSelectedSuggestionId: string | null
  agentNotes: string | null
  humanOverride: boolean       // true if human changed agent's pick
  humanSelectedSuggestionId: string | null  // null if human agreed with agent
  finalDecision: 'auto_approved' | 'escalated' | 'spot_check' | 'human_override'
  decidedAt: string            // ISO timestamp
}
```

This gives full transparency: what did the AI decide, why, and did a human agree or override?

#### Agent Review Strategies

| Strategy | Behavior |
|----------|----------|
| `pick_best` | Always select highest-confidence suggestion. Auto-approve if above threshold. |
| `pick_if_confident` | Only select if agent is confident. Otherwise escalate. Most conservative. |
| `always_escalate` | Agent provides recommendation but always pauses for human. Human sees AI suggestion as pre-selected default. |
| `custom` | Agent uses custom prompt to make arbitrary decisions. Full flexibility. |

#### Example Pipeline with Agent Review

```json
{
  "pipelineKey": "customs_hs_autonomous",
  "name": "HS Classification (AI-Assisted)",
  "steps": [
    {
      "stepKey": "translate",
      "type": "automated",
      "providerKey": "ai_translate",
      "providerConfig": { "targetLang": "pl", "fields": ["description"] }
    },
    {
      "stepKey": "classify_hs",
      "type": "automated",
      "providerKey": "isztar_hs_classification"
    },
    {
      "stepKey": "agent_review",
      "type": "agent_review",
      "label": "AI Agent Review",
      "agentConfig": {
        "prompt": "Review the HS code classification for this customs item. Consider the product description, the suggested codes, and their confidence scores. Select the most appropriate code. If the item is ambiguous or could fall into multiple categories, escalate to human review.",
        "autoApproveThreshold": 85,
        "escalateToHumanBelow": 50,
        "includeStepResults": true,
        "includeSuggestions": true,
        "strategy": "pick_if_confident",
        "maxAutoApprovals": 100
      }
    },
    {
      "stepKey": "human_review",
      "type": "review",
      "label": "Human Review (escalated items only)",
      "condition": { "field": "agent_review.finalDecision", "op": "eq", "value": "escalated" }
    }
  ]
}
```

In this pipeline:
- Easy items (high confidence from ISZTAR4 + agent agrees) → auto-approved, no human needed
- Ambiguous items → agent flags them, human reviews only those
- Result: human reviews maybe 10-20% of items instead of 100%

### Tier 4: AI Pipeline Designer — Agent Creates Pipelines

A specialized MCP tool that lets the AI assistant design and create pipeline configurations based on natural language descriptions.

| Tool | Description | Feature |
|------|-------------|---------|
| `item_processing_design_pipeline` | Given a natural language description of what needs to be processed, design a pipeline with appropriate steps and providers | `item_processing.configure` |

Example interaction:
```
User: "I need to classify products from a Chinese supplier invoice. 
       The descriptions are in Chinese."

AI Agent: "I'll create a pipeline for that."
→ Calls item_processing_design_pipeline({
    description: "Classify Chinese product descriptions into HS codes",
    itemSample: { description: "便携式电脑 15.6英寸" }
  })
→ Returns pipeline with: translate(zh→en) → translate(en→pl) → isztar_classify → agent_review → human_review(conditional)
→ AI explains: "I've created a 5-step pipeline that first translates Chinese to English, 
   then English to Polish for ISZTAR4, classifies, and uses AI review with human escalation 
   for low-confidence items."
```

### Tier 5: AI Anomaly Detection Across Jobs

A subscriber-driven system that analyzes completed jobs for patterns and anomalies.

File: `subscribers/job-anomaly-detection.ts`

After each `item_processing.job.completed` event:
- Compare agent review decisions across items in the job
- Flag inconsistencies (e.g., similar items classified differently)
- Compare with historical job data (same pipeline, similar items)
- Generate anomaly report stored in `job.result_summary.anomalies`

This turns the module from "process items" into "process items and learn from results."

---

## Widget Injection

File: `widgets/injection/ProcessItemsAction.tsx`

A headless injection widget that adds a "Process items" bulk action to any DataTable. When triggered, it opens a dialog to select a pipeline, then creates a job from the selected rows.

Mapped via `widgets/injection-table.ts` to target spots like `data-table:*:bulk-actions`.

---

## Module Files

| File | Export | Purpose |
|------|--------|---------|
| `index.ts` | `metadata` | Module metadata (id: `item_processing`) |
| `acl.ts` | `features` | RBAC features |
| `setup.ts` | `setup` | Tenant init, default role features, pipeline templates |
| `events.ts` | `eventsConfig` | Typed event declarations |
| `di.ts` | `register` | DI registrar |
| `ai-tools.ts` | `aiTools` | MCP AI tool definitions |
| `data/entities.ts` | — | ProcessingJob, ProcessingItem, ProcessingPipeline |
| `data/validators.ts` | — | Zod schemas |
| `lib/types.ts` | — | StepProvider, StepSuggestion, StepCondition, etc. |
| `lib/provider-registry.ts` | — | Register/get/list providers |
| `lib/processing-engine.ts` | — | Core engine (run, resume, retry) with conditional steps + chaining |
| `lib/job-service.ts` | — | Job CRUD + status management |
| `lib/pipeline-service.ts` | — | Pipeline CRUD + template clone |
| `lib/condition-evaluator.ts` | — | StepCondition evaluation on step_results |
| `lib/agent-reviewer.ts` | — | Agent-in-the-loop decision engine (Tier 3) |
| `lib/pipeline-designer.ts` | — | AI pipeline design from natural language (Tier 4) |
| `lib/anomaly-detector.ts` | — | Cross-job anomaly detection (Tier 5) |
| `providers/ai-transform.provider.ts` | — | Generic AI structured output provider |
| `providers/ai-translate.provider.ts` | — | AI translation provider |
| `providers/schema-validate.provider.ts` | — | Zod schema validation provider |
| `providers/http-webhook.provider.ts` | — | Generic HTTP call provider |
| `subscribers/job-completed-webhook.ts` | — | Webhook on job completion |
| `subscribers/job-anomaly-detection.ts` | — | Post-completion anomaly analysis (Tier 5) |
| `widgets/injection/ProcessItemsAction.tsx` | — | "Process items" bulk action widget |
| `widgets/injection-table.ts` | — | Widget-to-slot mappings |
| `components/PipelineStepsEditor.tsx` | — | Sortable step list (ChevronUp/Down reorder) |
| `components/StepCard.tsx` | — | Expandable step card with type-specific fields |
| `components/ProviderPicker.tsx` | — | Provider selector with category grouping |
| `components/ProviderConfigForm.tsx` | — | Dynamic form per provider type |
| `components/ConditionBuilder.tsx` | — | Inline condition editor |
| `components/KeyValueEditor.tsx` | — | Reusable key-value pair editor |
| `components/MappingEditor.tsx` | — | Input/output mapping editor |

---

## Queue Workers

| Queue | File | Concurrency | Notes |
|-------|------|-------------|-------|
| `item-processing-run` | `workers/run-job.ts` | 5 | I/O-bound (external API calls) |

---

## UI Pages

| Page | Description |
|------|-------------|
| `backend/item-processing/page.tsx` | Job list — DataTable with status, pipeline, progress, dates |
| `backend/item-processing/jobs/create/page.tsx` | Create job: select pipeline, add items |
| `backend/item-processing/jobs/[id]/page.tsx` | Job detail: item table with per-step status, review UI with suggestions |
| `backend/item-processing/pipelines/page.tsx` | Pipeline list — DataTable with name, steps count, status |
| `backend/item-processing/pipelines/create/page.tsx` | Pipeline create — CrudForm with StepsEditor |
| `backend/item-processing/pipelines/[id]/page.tsx` | Pipeline detail — CrudForm with StepsEditor + edit mode |

---

## Pipeline Management UI

### Overview

The pipeline management UI allows users to create, edit, and clone processing pipelines through a visual step editor. The design follows the existing `StepsEditor` pattern from the workflows module (arrow-button reordering, inline step cards) combined with `CrudForm` for pipeline metadata.

### Pipeline List Page

`backend/item-processing/pipelines/page.tsx`

DataTable with columns:
- **Name** — pipeline name (link to detail)
- **Key** — `pipeline_key` (monospace)
- **Steps** — step count badge
- **Status** — active/inactive toggle
- **Created** — date
- **Actions** — Edit, Clone, Deactivate

Row actions:
- **Clone** → `POST /api/item_processing/pipelines/:id/clone` → opens detail page of the clone
- **Deactivate/Activate** → toggle `is_active`

### Pipeline Create/Edit Page

`backend/item-processing/pipelines/create/page.tsx` and `backend/item-processing/pipelines/[id]/page.tsx`

Uses `CrudForm` with two sections:

#### Section 1: Pipeline Metadata

| Field | Type | Notes |
|-------|------|-------|
| Name | text input | required |
| Pipeline Key | text input | slug-format, unique per tenant, readonly on edit |
| Description | textarea | optional |
| Webhook URL | text input | optional, called on job completion |

#### Section 2: Steps Editor (StepsEditor component)

Reusable component: `components/PipelineStepsEditor.tsx`

Follows the workflows `StepsEditor` pattern:
- Vertical list of step cards
- **ChevronUp / ChevronDown** buttons to reorder (no drag & drop — consistent with existing codebase)
- **Plus** button to add a step (appended at end)
- **Trash** button to remove a step
- Each step is an expandable card

#### Step Card (collapsed)

```
┌─────────────────────────────────────────────────────────┐
│ [▲] [▼]  ① translate  ·  ai_translate  ·  automated  [✏️] [🗑️] │
└─────────────────────────────────────────────────────────┘
```

Shows: step index, stepKey, providerKey, step type. Click or edit icon to expand.

#### Step Card (expanded)

```
┌─────────────────────────────────────────────────────────┐
│ [▲] [▼]  Step 1                                    [🗑️] │
│                                                         │
│  Step Key:    [translate          ]                     │
│  Label:       [Translate to Polish]                     │
│  Type:        [automated ▼]  (automated | review | agent_review) │
│                                                         │
│  ── Provider (visible when type = automated) ──────── │
│  Provider:    [ai_translate ▼]   (picker from registry) │
│  Config:      [{ "targetLang": "pl", "fields": [...]}] │
│               (JSON editor or structured form per provider) │
│                                                         │
│  ── Agent Config (visible when type = agent_review) ── │
│  Strategy:    [pick_if_confident ▼]                     │
│  Prompt:      [textarea with instructions]              │
│  Auto-approve threshold: [85]                           │
│  Escalate below:         [50]                           │
│  Max auto-approvals:     [100]                          │
│                                                         │
│  ── Mappings (collapsible) ────────────────────────── │
│  Input Mapping:  [key-value pair editor]                │
│  Output Mapping: [key-value pair editor]                │
│                                                         │
│  ── Advanced (collapsible) ────────────────────────── │
│  Optional:   [ ] (checkbox)                             │
│  Retry:      max [3] retries, backoff [1000] ms         │
│  Condition:  [field] [op ▼] [value]  [+ Add condition]  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Provider Picker

The provider selector in each step card fetches available providers from `GET /api/item_processing/providers` and shows:

```
┌──────────────────────────────────────┐
│  Select Provider                     │
│                                      │
│  ── Built-in ──────────────────────  │
│  ○ ai_transform    Generic AI        │
│  ○ ai_translate    AI Translation    │
│  ○ schema_validate Schema Validation │
│  ○ http_webhook    HTTP Call         │
│                                      │
│  ── External ──────────────────────  │
│  ○ isztar_hs_classification  ISZTAR4 │
│                                      │
└──────────────────────────────────────┘
```

When a provider is selected, the Config section adapts. For known providers (built-in), show a structured form. For unknown providers, show a JSON editor.

### Provider Config Forms (per provider)

**ai_transform:**
| Field | Type |
|-------|------|
| Model | select (optional, default from tenant config) |
| Prompt | textarea with `{{field}}` interpolation hints |
| Output Schema | key-value editor (field name → type) |

**ai_translate:**
| Field | Type |
|-------|------|
| Target Language | select (ISO codes) |
| Source Language | select (default: auto) |
| Fields | multi-select / tags input (which fields to translate) |

**schema_validate:**
| Field | Type |
|-------|------|
| Schema | key-value editor (field → `{ type, required, min, max, minLength }`) |

**http_webhook:**
| Field | Type |
|-------|------|
| URL | text input |
| Method | select (GET/POST/PUT) |
| Headers | key-value editor |
| Body Template | JSON editor with `{{field}}` hints |
| Response Mapping | key-value editor |
| Timeout | number input (ms) |

### Condition Builder

For steps with conditions, an inline builder:

```
┌──────────────────────────────────────────────────┐
│  Run this step only when:                        │
│                                                  │
│  [classify_hs.confidence] [< ▼] [70]    [✕]    │
│  AND                                             │
│  [translate.status      ] [eq ▼] [success] [✕]  │
│                                                  │
│  [+ Add condition]                               │
└──────────────────────────────────────────────────┘
```

Field input uses a combobox with available `stepKey.field` paths from preceding steps. Operator dropdown shows `eq | neq | gt | gte | lt | lte | exists | contains`.

### Key-Value Pair Editor

Reusable component for inputMapping, outputMapping, headers, etc:

```
┌──────────────────────────────────────┐
│  Input Mapping                       │
│                                      │
│  [text     ] → [description     ] [✕]│
│  [quantity ] → [item_count      ] [✕]│
│                                      │
│  [+ Add mapping]                     │
└──────────────────────────────────────┘
```

### Pipeline Template Clone

When cloning a template, the create page opens pre-filled with all steps from the source pipeline. The user can modify steps before saving. The `pipeline_key` field is cleared and must be set to a new value.

### Components

| Component | File | Description |
|-----------|------|-------------|
| PipelineStepsEditor | `components/PipelineStepsEditor.tsx` | Sortable step list (ChevronUp/Down reorder) |
| StepCard | `components/StepCard.tsx` | Expandable step card with type-specific fields |
| ProviderPicker | `components/ProviderPicker.tsx` | Provider selector with category grouping |
| ProviderConfigForm | `components/ProviderConfigForm.tsx` | Dynamic form per provider type |
| ConditionBuilder | `components/ConditionBuilder.tsx` | Inline condition editor |
| KeyValueEditor | `components/KeyValueEditor.tsx` | Reusable key-value pair editor |
| MappingEditor | `components/MappingEditor.tsx` | Input/output mapping editor |

---

## Implementation Phases

### Phase 1: Scaffold + Data Layer

- [ ] Module scaffold (index.ts, acl.ts, events.ts)
- [ ] MikroORM entities (ProcessingJob, ProcessingItem, ProcessingPipeline)
- [ ] Zod validators
- [ ] Core types (StepProvider, PipelineStepDefinition, StepCondition)
- [ ] Database migration (`yarn db:generate`)
- [ ] setup.ts (defaultRoleFeatures)

### Phase 2: Core Engine

- [ ] Provider registry (register/get/getAll)
- [ ] Condition evaluator (StepCondition evaluation on step_results)
- [ ] Job service (CRUD, status transitions, counter updates)
- [ ] Pipeline service (CRUD, template clone)
- [ ] Processing engine (run/resume/retry with conditional steps + step chaining)
- [ ] DI registration (di.ts)

### Phase 3: Built-in Providers

- [ ] `ai_transform` provider (AI SDK generateObject with prompt template)
- [ ] `ai_translate` provider (AI translation with field mapping)
- [ ] `schema_validate` provider (Zod schema from config)
- [ ] `http_webhook` provider (generic HTTP call with template interpolation)
- [ ] Provider registration in di.ts

### Phase 4: API Routes + Events

- [ ] OpenAPI factory
- [ ] Job API routes (list, create, detail, start, cancel, retry)
- [ ] Item API routes (list, review per item, bulk review submit)
- [ ] Pipeline API routes (list, create, detail, update)
- [ ] Provider list API route
- [ ] Event emission in engine
- [ ] Progress tracking via ProgressService

### Phase 5: Worker + Subscribers

- [ ] Queue worker (run-job.ts, concurrency: 5)
- [ ] Webhook subscriber (job-completed-webhook.ts)

### Phase 6: AI Tools + Widget Injection

- [ ] ai-tools.ts (5 MCP tools: create_job, get_job, submit_review, list_pipelines, list_providers)
- [ ] ProcessItemsAction widget (bulk action for other DataTables)
- [ ] injection-table.ts mapping

### Phase 6b: Agent-in-the-Loop (Tier 3)

- [ ] `lib/agent-reviewer.ts` — AI decision engine with confidence thresholds
- [ ] `agent_review` step type handling in processing engine
- [ ] AgentReviewConfig type and validators
- [ ] Agent review audit trail in step_results
- [ ] Events: item.agent_decided, item.agent_escalated
- [ ] Conditional human_review step after agent (items agent escalated)

### Phase 6c: AI Pipeline Designer (Tier 4)

- [ ] `lib/pipeline-designer.ts` — generates pipeline config from natural language
- [ ] `item_processing_design_pipeline` MCP tool
- [ ] Provider capability introspection (what providers are available, what they do)

### Phase 6d: Anomaly Detection (Tier 5)

- [ ] `lib/anomaly-detector.ts` — cross-item consistency analysis
- [ ] `subscribers/job-anomaly-detection.ts` — persistent subscriber on job.completed
- [ ] Anomaly report in job.result_summary.anomalies

### Phase 7: UI — Jobs

- [ ] Job list page (DataTable with status, pipeline, progress)
- [ ] Job create page (pipeline selector + item input)
- [ ] Job detail page (item table + per-step status + review UI with suggestions)

### Phase 7b: UI — Pipeline Management

- [ ] Pipeline list page (DataTable with name, steps count, status, clone action)
- [ ] PipelineStepsEditor component (sortable step list with ChevronUp/Down reorder)
- [ ] StepCard component (expandable card with type-specific fields)
- [ ] ProviderPicker component (provider selector with category grouping)
- [ ] ProviderConfigForm component (dynamic form per provider: ai_transform, ai_translate, schema_validate, http_webhook)
- [ ] ConditionBuilder component (inline condition editor with field combobox + operator)
- [ ] KeyValueEditor + MappingEditor components (reusable for mappings, headers)
- [ ] Pipeline create page (CrudForm + PipelineStepsEditor)
- [ ] Pipeline detail/edit page (CrudForm + PipelineStepsEditor + edit mode)
- [ ] Pipeline clone flow (pre-filled create page from template)

### Phase 8: Demo Provider (ISZTAR4) + Templates

- [ ] ISZTAR4 API client
- [ ] `isztar_hs_classification` StepProvider implementation
- [ ] Pipeline templates in seedDefaults()
- [ ] i18n (en.json + pl.json)
- [ ] End-to-end demo flow

### Phase 9: Finalization

- [ ] Activate module in `apps/mercato/src/modules.ts`
- [ ] `yarn generate`
- [ ] `yarn build` verification
- [ ] `yarn lint` check

---

## Risks & Impact Review

### External API Unavailability
- **Scenario**: ISZTAR4 or other provider API is down during processing
- **Severity**: Medium
- **Mitigation**: Per-item error handling (failed items don't block others); retry mechanism; optional steps skip on failure
- **Residual risk**: Items may need manual re-processing

### Large Batch Performance
- **Scenario**: Job with 1000+ items causes memory pressure or timeout
- **Severity**: Medium
- **Mitigation**: Queue worker processes items in configurable batch sizes; progress tracking shows real-time status; cancellation support
- **Residual risk**: Very large batches may take significant time

### Tenant Data Isolation
- **Scenario**: Cross-tenant data leak via shared provider registry or job queries
- **Severity**: Critical
- **Mitigation**: All queries filter by tenantId + organizationId; provider registry is stateless (no tenant data); pipeline configs are tenant-scoped
- **Residual risk**: None

### Review Step Stale State
- **Scenario**: User starts review but doesn't complete it; job stays paused indefinitely
- **Severity**: Low
- **Mitigation**: Jobs can be cancelled at any time; no automatic timeout (user controls the pace)
- **Residual risk**: Orphaned paused jobs; acceptable for initial release

---

## Changelog

### 2026-04-10
- Initial specification created for hackathon
- Core architecture: StepProvider registry, processing engine, human-in-the-loop review
- Data models: ProcessingJob, ProcessingItem, ProcessingPipeline
- Demo provider: ISZTAR4 HS code classification
- Added: Conditional steps (StepCondition with per-item evaluation)
- Added: Step chaining via inputMapping/outputMapping
- Added: 4 built-in providers (ai_transform, ai_translate, schema_validate, http_webhook)
- Added: Pipeline templates seeded via setup.ts
- Added: Webhook on job completion subscriber
- Added: 4 MCP AI tools (create_job, get_job, submit_review, list_providers)
- Added: Widget injection (ProcessItemsAction bulk action for other DataTables)
- Expanded to 9 implementation phases
- Added: Tier 3 — Agent-in-the-loop (`agent_review` step type with confidence thresholds, auto-approve/escalate)
- Added: Tier 4 — AI Pipeline Designer (MCP tool generates pipeline from natural language)
- Added: Tier 5 — Anomaly Detection (cross-job pattern analysis)
- Added: Agent review audit trail (decidedBy, agentConfidence, agentReasoning, humanOverride)
- Added: 3 new module files (agent-reviewer.ts, pipeline-designer.ts, anomaly-detector.ts)
- Added: 2 new events (item.agent_decided, item.agent_escalated)
- Added: AgentReviewConfig with 4 strategies (pick_best, pick_if_confident, always_escalate, custom)
- Added: Pipeline Management UI section — full spec for pipeline builder with StepsEditor, ProviderPicker, ConditionBuilder, per-provider config forms
- Added: Phase 7b (UI — Pipeline Management) with 10 implementation tasks
- Added: 7 new component files (PipelineStepsEditor, StepCard, ProviderPicker, ProviderConfigForm, ConditionBuilder, KeyValueEditor, MappingEditor)
- Expanded UI Pages with pipeline create/edit pages
