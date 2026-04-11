# WS-8: Visual UI for item_processing module

**Status**: Plan
**Date**: 2026-04-11
**Priority**: High (UI completeness for demo)

## Context

Current UI for `item_processing` module is minimal:
- **Pipeline create/edit**: JSON textarea (requires knowing schema, error-prone)
- **Job create**: JSON textarea for items
- **Job detail**: DataTable with expandable rows + simple review panel
- **Missing**: drag-drop pipeline editor, per-provider form builders, graphical items editor, enhanced review panel with AI recommendations

Target user (customs agent / operator) should not write JSON manually. We need a **fully graphical UI** at the level of n8n / Zapier / workflows module.

## Key finding: Open Mercato has everything we need

The `workflows` module already provides battle-tested patterns:
- `@xyflow/react` v12 (React Flow) — installed and used
- `packages/core/src/modules/workflows/backend/definitions/visual-editor/page.tsx` — complete working visual editor as reference
- `WorkflowGraph.tsx`, `WorkflowNodeCard.tsx`, `StepsEditor.tsx`, `NodeEditDialog.tsx` — reusable components
- `JsonBuilder`, `CrudForm`, `FormFieldArrayEditor` — form builders
- `useConfirmDialog`, `flash()`, `FormHeader`/`FormFooter` — UX primitives

## Goal

Build 3 new views + extend 2 existing ones, using patterns from workflows module:

1. **Pipeline Visual Editor** — drag-drop canvas (React Flow) with node palette, provider-specific config forms, graph validation
2. **Pipeline List** — add clone/activate/deactivate actions
3. **Job Create Page** — visual items builder (card-based, not JSON)
4. **Job Detail Page** — enhanced review panel with inline editing, filter items per step, agent recommendations UI
5. **Reusable components**: `PipelineGraph`, `StepNode` variants, `StepConfigForm`

## Architecture

### Layer 1: Reusable pipeline components

Location: `packages/core/src/modules/item_processing/components/`

| Component | Based on | Purpose |
|-----------|----------|---------|
| `PipelineGraph.tsx` | `workflows/components/WorkflowGraph.tsx` | React Flow wrapper: pan, zoom, minimap, read-only/edit, custom nodes/edges |
| `PipelineNodeCard.tsx` | `workflows/components/WorkflowNodeCard.tsx` | Visual step card (icon, title, status badge, config preview) |
| `nodes/AutomatedStepNode.tsx` | `workflows/components/nodes/AutomatedNode.tsx` | Node type: automated — with providerKey, config preview |
| `nodes/ReviewStepNode.tsx` | `workflows/components/nodes/UserTaskNode.tsx` | Node type: review — human decision |
| `nodes/AgentReviewStepNode.tsx` | new pattern | Node type: agent_review — with thresholds preview (85/50), strategy badge |
| `StepsEditor.tsx` | `workflows/components/StepsEditor.tsx` | Array editor with chevron up/down/delete, expand/collapse |
| `StepConfigForm.tsx` | `workflows/components/NodeEditDialogCrudForm.tsx` | Dynamic form rendering fields per providerKey |
| `StepTransitionEdge.tsx` | `workflows/components/WorkflowTransitionEdge.tsx` | Custom edge with condition label (if step has condition) |
| `PipelinePalette.tsx` | new | Sidebar palette: provider categories (Classification, Enrichment, Validation, Transformation) + drag to canvas |
| `PipelineLegend.tsx` | `workflows/components/WorkflowLegend.tsx` | Step type legend |
| `ItemCard.tsx` | new | Card for single item — input summary, status badges, step results preview, selected HS code |
| `ItemsBuilder.tsx` | new | Create/edit items: card list with add/delete/duplicate, auto-detect fields from pipeline |
| `ReviewPanelEnhanced.tsx` | current rebuild | Review with inline edit, agent recommendations highlight, override tracking |

### Layer 2: Visual editor pages

Location: `packages/core/src/modules/item_processing/backend/item-processing/`

#### 2.1 Pipeline Visual Editor — `pipelines/[id]/edit/page.tsx` (NEW)

Layout:
- **Top**: FormHeader with pipeline name, status, save/cancel
- **Left sidebar**: Palette with providers (grouped by category) — drag to canvas
- **Center**: PipelineGraph (React Flow) with nodes + edges
- **Right sidebar**: Collapsible config panel — shows when you click a node
  - StepConfigForm for selected node
  - Provider-specific fields (e.g. ai_transform: prompt textarea + outputSchema builder)
  - Condition editor (dot-notation picker from previous steps)
  - Input/output mapping editor
- **Bottom**: Legend + "Validate" button (checks graph)

Features:
- Drag provider from palette to canvas → creates AutomatedStepNode
- Click "Add Review Step" / "Add Agent Review" → creates respective node type
- Connect nodes by dragging from handle → creates edge (transition)
- Click node → opens right sidebar with config form
- Delete node → confirmDialog
- Save → converts nodes/edges to `PipelineStepDefinition[]` and POST/PUT
- Load existing pipeline: `definitionToGraph` reverse — `graphToDefinition`

Helper files:
- `lib/graph-utils.ts` — `definitionToGraph()` + `graphToDefinition()` + `validatePipelineGraph()` (pattern: workflows/lib/graph-utils.ts)

#### 2.2 Pipeline List — `pipelines/page.tsx` (EXTEND)

Add:
- Row actions: Edit (→ visual editor), Clone, Toggle active
- "New Pipeline" modal: template picker (customs_hs / validation / generic) → redirect to editor with pre-filled nodes
- Status badges (Active/Inactive)
- Steps count + step types preview (small icons)

#### 2.3 Job Create — `jobs/create/page.tsx` (REBUILD)

Replace textarea for items with:
- Pipeline selector (existing)
- **ItemsBuilder**: card-based editor
  - Auto-detect fields from pipeline config (scan providers for required fields)
  - Add item → creates empty card with fields
  - Duplicate item
  - Delete item (confirm)
  - Bulk paste: "Paste JSON array" button → paste → parse → create cards
  - Bulk CSV upload: file upload → parse → create cards
  - Preview: "Items will be processed through: {step1} → {step2} → ..."
- "Create & Start" / "Create as Draft"

#### 2.4 Job Detail — `jobs/[id]/page.tsx` (EXTEND)

Current view has header + items table + review panel. Add:

**Pipeline visualization tab**:
- Small PipelineGraph (read-only) with highlighted current step
- Per-step counter: processed/failed/skipped

**Items tab** (instead of plain DataTable):
- Filter bar: status, step, confidence range (agent decisions)
- View switcher: Table / Cards
- Card view: ItemCard components with per-step status badges + step results preview
- Expandable: full input/output data, step results JSON

**Review panel** (enhanced):
- Separator: "X items need your review" + "Y items auto-approved by AI (spot-check available)"
- Per-item card with:
  - Input data (key fields)
  - Agent recommendation (if any): "AI recommends {code} ({confidence}%) — {reasoning}"
  - Suggestions as RadioGroup (not raw radio) with AI's pick pre-selected
  - "Accept AI" / "Override" buttons
  - Inline text input for freeform selection
- Bulk actions: "Accept all AI recommendations"
- Progress: "0 of 5 reviewed"

**Anomaly report tab** (if job.result_summary.anomalies exists):
- List of anomalies with severity badges
- Affected items links
- Recommendation text

## Files to create/modify

### New (15)
```
packages/core/src/modules/item_processing/
├── lib/graph-utils.ts
├── components/
│   ├── PipelineGraph.tsx
│   ├── PipelineNodeCard.tsx
│   ├── PipelinePalette.tsx
│   ├── PipelineLegend.tsx
│   ├── StepConfigForm.tsx
│   ├── StepTransitionEdge.tsx
│   ├── StepsEditor.tsx
│   ├── ItemsBuilder.tsx
│   ├── ItemCard.tsx
│   ├── ReviewPanelEnhanced.tsx
│   └── nodes/
│       ├── AutomatedStepNode.tsx
│       ├── ReviewStepNode.tsx
│       └── AgentReviewStepNode.tsx
└── backend/item-processing/pipelines/[id]/edit/
    ├── page.tsx
    └── page.meta.ts
```

### Modifications (3)
```
packages/core/src/modules/item_processing/backend/item-processing/
├── pipelines/page.tsx — row actions, clone, templates
├── jobs/create/page.tsx — ItemsBuilder instead of textarea
└── jobs/[id]/page.tsx — tabs, enhanced review, pipeline visualization
```

## Reference files to copy from

| Pattern | From | To |
|---------|------|----|
| React Flow wrapper | `packages/core/src/modules/workflows/components/WorkflowGraph.tsx` | `components/PipelineGraph.tsx` |
| Node cards | `packages/core/src/modules/workflows/components/WorkflowNodeCard.tsx` | `components/PipelineNodeCard.tsx` |
| Node types | `packages/core/src/modules/workflows/components/nodes/*` | `components/nodes/*` |
| Steps editor | `packages/core/src/modules/workflows/components/StepsEditor.tsx` | `components/StepsEditor.tsx` |
| Visual editor page | `packages/core/src/modules/workflows/backend/definitions/visual-editor/page.tsx` | `backend/item-processing/pipelines/[id]/edit/page.tsx` |
| Graph utils | `packages/core/src/modules/workflows/lib/graph-utils.ts` | `lib/graph-utils.ts` |
| Node edit dialog | `packages/core/src/modules/workflows/components/NodeEditDialogCrudForm.tsx` | `components/StepConfigForm.tsx` |
| Array editor (expand/collapse) | `packages/core/src/modules/workflows/components/fields/ActivityArrayEditor.tsx` | `components/ItemsBuilder.tsx` |
| JSON builder | `packages/ui/src/backend/JsonBuilder.tsx` | Reuse directly |

## Implementation tasks

13 tasks, ~35 story points, ~14-18h work:

| # | Task | Priority | Est |
|---|------|----------|-----|
| 1 | Graph utils (definitionToGraph, graphToDefinition, validate) | High | 2 |
| 2 | Node components (3 types) + PipelineNodeCard | High | 3 |
| 3 | PipelineGraph wrapper (React Flow) | High | 2 |
| 4 | Step config forms per provider (5 forms) | High | 5 |
| 5 | Pipeline visual editor page | Urgent | 5 |
| 6 | Pipeline palette component | High | 2 |
| 7 | Pipeline list enhancements (clone, templates) | Medium | 2 |
| 8 | Items builder (card-based) | High | 3 |
| 9 | Job create page rebuild | High | 2 |
| 10 | Item card component | Medium | 2 |
| 11 | Enhanced review panel | High | 3 |
| 12 | Job detail tabs + pipeline visualization | High | 3 |
| 13 | Unit tests for graph-utils | Medium | 1 |

## Verification

### Automated
- Unit tests for `graph-utils.ts` — round-trip definition ↔ graph + validation (8-10 tests)
- Unit tests for form validation — behavior on invalid config

### Manual (smoke test)
1. Start dev server, log in
2. Navigate to `/backend/item-processing/pipelines/new?template=customs_hs`
3. See pre-filled graph with 4 nodes
4. Drag new provider from palette → canvas
5. Connect with existing node
6. Click node → sidebar with config form → edit prompt
7. Save → verify definition saved correctly (GET /pipelines/[id])
8. Navigate to `/backend/item-processing/jobs/create`
9. Select pipeline → ItemsBuilder renders fields
10. Add 3 items with different values
11. Create & Start → redirect to detail
12. Wait until job is paused
13. Review panel → select AI recommendations → Submit
14. Verify job completed

### Integration test (optional)
Playwright test that executes scenario 1-14 automatically.
