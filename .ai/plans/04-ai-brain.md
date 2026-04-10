# WS-4: AI Brain

**Kto**: Osoba A
**Branch**: `feature/ip-ai-brain`
**Czas**: ~7h
**Zalezy od**: WS-2 (processing engine)

---

## Cel

Trzy AI-native funkcje ktore robia z tego modulu cos unikalnego:

1. **Agent Reviewer** (Tier 3) — AI autonomicznie podejmuje decyzje z eskalacja do czlowieka
2. **Pipeline Designer** (Tier 4) — AI generuje pipeline z opisu w jezyku naturalnym
3. **Anomaly Detector** (Tier 5) — AI analizuje wyniki jobow po zakonczeniu

## Pliki do stworzenia

### 1. `lib/agent-reviewer.ts` — Serce AI decyzji

```typescript
import { generateObject } from 'ai'
import { z } from 'zod'
import type { AgentReviewConfig, AgentReviewResult, StepSuggestion, TenantScope } from './types'
```

**Export**: `createAgentReviewer()`

**Metody**:
- `reviewItem(input: AgentReviewInput): Promise<AgentReviewOutput>`
- `processStep(job, step, items, scope): Promise<AgentStepResult>`

#### `reviewItem` — decyzja per item

**Input**:
```typescript
interface AgentReviewInput {
  itemInputData: Record<string, unknown>
  itemOutputData: Record<string, unknown>
  stepResults: Record<string, unknown>
  suggestions: StepSuggestion[]
  agentConfig: AgentReviewConfig
  pipelineContext: { pipelineName: string; stepKey: string }
}
```

**Algorytm**:

```
1. BUILD PROMPT
   systemPrompt = "You are an expert reviewer analyzing batch processing results.
     You must evaluate the item data and previous step results, then make a decision.
     
     PIPELINE: {pipelineContext.pipelineName}
     DECISION STEP: {pipelineContext.stepKey}
     
     YOUR INSTRUCTIONS:
     {agentConfig.prompt}"
   
   userPrompt = buildUserPrompt(input)
   // Contains: item data, output data, step results, formatted suggestions

2. BUILD OUTPUT SCHEMA
   schema = z.object({
     selectedSuggestionId: z.string().nullable().describe('ID of chosen suggestion, or null'),
     selectedValue: z.record(z.unknown()).nullable().describe('Custom value if not picking suggestion'),
     confidence: z.number().min(0).max(100).describe('How confident you are in this decision'),
     reasoning: z.string().describe('Why you made this choice'),
     needsHumanReview: z.boolean().describe('True if you think a human should verify'),
     notes: z.string().nullable().describe('Additional context'),
   })

3. CALL AI
   result = await generateObject({
     model: resolveModel(),  // anthropic or openai from env
     system: systemPrompt,
     prompt: userPrompt,
     schema,
   })

4. APPLY STRATEGY MODIFIERS
   switch (agentConfig.strategy):
     'pick_best':
       If suggestions exist AND result.selectedSuggestionId is null:
         Auto-select highest confidence suggestion
         result.selectedSuggestionId = suggestions[0].id
     'pick_if_confident':
       No modification (agent decides freely)
     'always_escalate':
       result.needsHumanReview = true  // force escalation
     'custom':
       No modification

5. VALIDATE
   If selectedSuggestionId AND !suggestions.find(s => s.id === selectedSuggestionId):
     Log warning: "Agent selected non-existent suggestion"
     result.needsHumanReview = true  // escalate
   
   Clamp confidence to 0-100

6. RETURN AgentReviewOutput
```

#### `processStep` — orchestracja agent review dla calego step

**Input**: job, step (PipelineStepDefinition), items (ProcessingItem[]), scope

**Algorytm**:

```
1. INIT
   autoApprovalCount = 0
   escalatedItems = []
   
2. FOR EACH ITEM:
   a. Call reviewItem(...)
   
   b. BUILD AgentReviewResult:
      agentResult = {
        decidedBy: TBD,
        agentConfidence: output.confidence,
        agentReasoning: output.reasoning,
        agentSelectedSuggestionId: output.selectedSuggestionId,
        agentNotes: output.notes,
        humanOverride: false,
        humanSelectedSuggestionId: null,
        finalDecision: TBD,
        decidedAt: new Date().toISOString(),
      }
   
   c. APPLY DECISION RULES:
      If output.confidence >= agentConfig.autoApproveThreshold
         AND !output.needsHumanReview
         AND autoApprovalCount < (agentConfig.maxAutoApprovals ?? Infinity):
        
        → AUTO-APPROVE
        agentResult.decidedBy = 'agent'
        agentResult.finalDecision = 'auto_approved'
        item.selected_values[step.stepKey] = output.selectedValue ?? suggestionToValue(output.selectedSuggestionId)
        item.status = stays in pipeline (not 'completed' yet — more steps may follow)
        autoApprovalCount++
        Emit: item_processing.item.agent_decided
      
      Else if output.confidence < agentConfig.escalateToHumanBelow
              OR output.needsHumanReview
              OR autoApprovalCount >= (agentConfig.maxAutoApprovals ?? Infinity):
        
        → ESCALATE TO HUMAN
        agentResult.decidedBy = 'agent_escalated_to_human'
        agentResult.finalDecision = 'escalated'
        item.status = 'awaiting_review'
        // Agent recommendation saved in step_results — UI shows it as pre-fill
        escalatedItems.push(item)
        Emit: item_processing.item.agent_escalated
      
      Else:
        → AUTO-APPROVE WITH SPOT-CHECK FLAG
        agentResult.decidedBy = 'agent'
        agentResult.finalDecision = 'spot_check'
        item.selected_values[step.stepKey] = output.selectedValue ?? suggestionToValue(...)
        autoApprovalCount++
        Emit: item_processing.item.agent_decided
   
   d. SAVE
      item.step_results[step.stepKey] = agentResult
      Save item to DB

3. RETURN
   {
     totalReviewed: items.length,
     autoApproved: autoApprovalCount,
     escalated: escalatedItems.length,
     hasEscalated: escalatedItems.length > 0,
   }
```

#### When human submits review on escalated item

W `resumeAfterReview` (processing-engine.ts), po tym jak human submituje review na agent-escalated item:

```
For each submitted item:
  If step_results[stepKey].decidedBy === 'agent_escalated_to_human':
    agentResult = step_results[stepKey]
    humanChoice = selected_values[stepKey]
    agentChoice = agentResult.agentSelectedSuggestionId
    
    If humanChoice matches agentChoice:
      agentResult.humanOverride = false
      agentResult.finalDecision = 'escalated'  // human confirmed
    Else:
      agentResult.humanOverride = true
      agentResult.humanSelectedSuggestionId = humanChoice
      agentResult.finalDecision = 'human_override'
    
    Save updated agentResult
```

#### Utility: `buildUserPrompt`

```
ITEM DATA:
Description: {input_data.description}
Quantity: {input_data.quantity}
Value: {input_data.total_value} {input_data.currency}
[... other fields]

ENRICHED DATA (from previous steps):
Translated description: {output_data.description_pl}
[... other accumulated data]

PREVIOUS STEP RESULTS:
Step "classify_hs":
  Status: needs_review
  Confidence: 72
  Suggestions:
    1. [8471.30] Portable computers (confidence: 92%)
    2. [8471.41] Data processing machines (confidence: 78%)
    3. [8528.71] Video monitors (confidence: 45%)

YOUR TASK: Select the most appropriate option or escalate to human review.
```

#### Utility: `resolveModel`

```typescript
function resolveModel() {
  const provider = process.env.AI_PROVIDER ?? 'anthropic'
  const modelId = process.env.AI_MODEL ?? 'claude-sonnet-4-5-20250514'
  
  if (provider === 'anthropic') {
    const { createAnthropic } = require('@ai-sdk/anthropic')
    return createAnthropic()(modelId)
  }
  if (provider === 'openai') {
    const { createOpenAI } = require('@ai-sdk/openai')
    return createOpenAI()(modelId)
  }
  throw new Error(`Unknown AI provider: ${provider}`)
}
```

### 2. Integration z processing-engine.ts

Osoba A modyfikuje swoj wlasny `processing-engine.ts` z WS-2:

Dodaj do `EngineDeps`:
```typescript
agentReviewer?: ReturnType<typeof createAgentReviewer>
```

W step loop, case `agent_review`:
```typescript
if (step.type === 'agent_review') {
  if (!deps.agentReviewer) throw new Error('Agent reviewer not available')
  
  const pendingItems = await loadNonFailedItems(jobId, scope)
  const result = await deps.agentReviewer.processStep(job, step, pendingItems, scope)
  
  if (result.hasEscalated) {
    await jobService.updateStatus(jobId, 'paused', scope)
    await emitItemProcessingEvent('item_processing.job.paused_for_review', { jobId, ...scope })
    return  // stop — human reviews escalated items
  }
  
  await emitItemProcessingEvent('item_processing.job.step_completed', {
    jobId, stepKey: step.stepKey, ...scope,
    agentStats: { autoApproved: result.autoApproved, escalated: result.escalated },
  })
  continue  // all auto-approved, next step
}
```

### 3. `lib/pipeline-designer.ts` — AI tworzy pipeline

```typescript
export function createPipelineDesigner() {
  return {
    async designPipeline(input: DesignPipelineInput): Promise<DesignPipelineOutput>
  }
}
```

**Algorytm**:

```
1. Collect context:
   - Available providers (from registry): providerKey, displayName, category, description
   - Item sample (if provided)
   - User preferences (includeAgentReview, includeHumanReview, max steps)

2. System prompt:
   "You are a pipeline architect for a batch item processing system.
    Design an optimal processing pipeline based on the user's description.
    
    AVAILABLE PROVIDERS:
    {providers.map(p => `- ${p.providerKey} (${p.category}): ${p.displayName}`).join('\n')}
    
    AVAILABLE STEP TYPES:
    - automated: Runs a provider on each item
    - review: Pauses for human to review and select
    - agent_review: AI agent reviews with confidence thresholds
      Config: prompt, autoApproveThreshold (0-100), escalateToHumanBelow (0-100), strategy
    
    RULES:
    - Use ai_translate before providers that need Polish text (like ISZTAR)
    - Use schema_validate early to catch bad data
    - Place agent_review before human review to reduce human workload
    - End with human review for safety (conditional on agent escalation)
    - Keep pipeline under {max} steps
    - Use inputMapping/outputMapping for field chaining between steps"

3. generateObject with pipeline schema

4. Post-validate:
   - All providerKeys exist in registry (replace unknown with ai_transform + appropriate prompt)
   - stepKeys unique
   - agentConfig valid for agent_review steps

5. Return { pipelineKey, name, description, steps, reasoning }
```

**Edge cases**:
- AI generates unknown providerKey → replace with `ai_transform` z promptem opisujacym co provider mial robic
- AI generates invalid agentConfig → fix defaults (threshold: 80/40, strategy: pick_if_confident)
- No providers available → pipeline z samymi ai_transform + review

### 4. MCP tool dla pipeline designer

Dodaj do `ai-tools.ts` (Osoba B tworzy plik, Osoba A dodaje ten tool):

```typescript
{
  name: 'item_processing_design_pipeline',
  description: 'Design a processing pipeline from natural language. Analyzes available providers and creates optimal step configuration. Returns pipeline definition ready to create.',
  inputSchema: z.object({
    description: z.string().describe('What needs to be processed'),
    itemSample: z.record(z.unknown()).optional().describe('Example item'),
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
      preferences: { includeAgentReview: input.includeAgentReview, includeHumanReview: input.includeHumanReview, maxStepCount: 10 },
    })
  },
}
```

### 5. `lib/anomaly-detector.ts` — Analiza po zakonczeniu

```typescript
export function createAnomalyDetector() {
  return {
    async analyzeJob(jobId: string, items: ProcessingItem[], scope: TenantScope): Promise<AnomalyReport>
  }
}
```

**Podejscie**: AI-driven (nie implementujemy algorytmy statystyczne — uzywamy AI do analizy).

**Algorytm**:

```
1. Prepare summary:
   - Total items, statuses breakdown
   - Per-step: success/error/skip counts
   - If agent_review: auto-approved vs escalated vs human-override counts
   - Sample of items (max 50) z ich step_results

2. System prompt:
   "You are a quality analyst reviewing batch processing results.
    Analyze the following job results for anomalies and inconsistencies.
    
    JOB SUMMARY:
    {summary}
    
    ITEM SAMPLES:
    {samples}
    
    Look for:
    - Similar items classified differently (inconsistent decisions)
    - Unusually low/high confidence outliers
    - Cases where AI agent and human disagreed frequently
    - Duplicate or near-duplicate items
    - Any patterns suggesting systematic errors"

3. generateObject with AnomalyReport schema

4. Return report
```

**AnomalyReport schema**:
```typescript
z.object({
  anomalies: z.array(z.object({
    type: z.enum(['inconsistent_classification', 'outlier_confidence', 'agent_human_disagreement', 'duplicate_items', 'systematic_error']),
    severity: z.enum(['low', 'medium', 'high']),
    affectedItemIds: z.array(z.string()),
    description: z.string(),
    recommendation: z.string(),
  })),
  summary: z.object({
    totalItems: z.number(),
    anomalousItems: z.number(),
    overallQuality: z.enum(['good', 'acceptable', 'concerning', 'poor']),
    keyInsight: z.string(),
  }),
})
```

### 6. `subscribers/job-anomaly-detection.ts`

```typescript
export const metadata = {
  event: 'item_processing.job.completed',
  persistent: true,
  id: 'item-processing:anomaly-detection',
}

export default async function handler(payload, ctx) {
  const em = ctx.resolve('em').fork()
  const items = await em.find(ProcessingItem, {
    jobId: payload.jobId,
    tenantId: payload.tenantId,
  })
  
  if (items.length < 3) return  // too few items for meaningful analysis
  
  const detector = ctx.resolve('itemProcessingAnomalyDetector')
  const report = await detector.analyzeJob(payload.jobId, items, {
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
  })
  
  if (report.anomalies.length > 0) {
    await em.nativeUpdate(ProcessingJob,
      { id: payload.jobId },
      { resultSummary: raw(`jsonb_set(COALESCE(result_summary, '{}'), '{anomalies}', '${JSON.stringify(report)}')`) }
    )
  }
}
```

### 7. Update `di.ts` (local — merge w WS-6)

```typescript
import { createAgentReviewer } from './lib/agent-reviewer'
import { createPipelineDesigner } from './lib/pipeline-designer'
import { createAnomalyDetector } from './lib/anomaly-detector'

// Add to register():
itemProcessingAgentReviewer: asFunction(() => createAgentReviewer()).scoped().proxy(),
itemProcessingPipelineDesigner: asFunction(() => createPipelineDesigner()).scoped().proxy(),
itemProcessingAnomalyDetector: asFunction(() => createAnomalyDetector()).scoped().proxy(),

// Update engine deps:
itemProcessingEngine: asFunction(({ em, itemProcessingJobService, progressService, itemProcessingAgentReviewer }) =>
  createProcessingEngine({
    em,
    jobService: itemProcessingJobService,
    progressService,
    agentReviewer: itemProcessingAgentReviewer,
  })
).scoped().proxy(),
```

## Edge cases — kompletna lista

| Scenariusz | Komponent | Obsluga |
|-----------|-----------|---------|
| AI rate limit | agent-reviewer | Throw → engine retryPolicy handles |
| AI returns invalid suggestionId | agent-reviewer | Log warning, force escalation |
| AI confidence out of range | agent-reviewer | Clamp 0-100 |
| AI timeout | agent-reviewer | 30s AbortController, throw |
| maxAutoApprovals reached | agent-reviewer | Remaining items forced escalation |
| No suggestions from prior step | agent-reviewer | Agent creates custom selectedValue |
| Prompt injection via item data | agent-reviewer | Truncate to 5000 chars, AI SDK guardrails |
| All items auto-approved | engine integration | No pause, continue to next step |
| All items escalated | engine integration | Pause for human review |
| Mixed auto/escalated | engine integration | Pause, human reviews only escalated |
| Human agrees with agent | resume logic | humanOverride = false |
| Human overrides agent | resume logic | humanOverride = true, track both choices |
| Designer generates unknown provider | pipeline-designer | Replace with ai_transform |
| Designer generates 20 steps | pipeline-designer | Truncate to max |
| Anomaly detector on < 3 items | subscriber | Skip analysis |
| AI provider unavailable | all AI components | Throw, let caller handle |

## Definition of Done

- [ ] `agent-reviewer.ts` — reviews items, applies thresholds, escalates
- [ ] `agent_review` step type works in engine (auto-approve + escalate)
- [ ] Human can review agent-escalated items and override
- [ ] AgentReviewResult audit trail saved per item
- [ ] `pipeline-designer.ts` — generates valid pipeline from text
- [ ] `item_processing_design_pipeline` MCP tool works
- [ ] `anomaly-detector.ts` — analyzes completed jobs
- [ ] Anomaly subscriber fires on job.completed
- [ ] `yarn build` passes on branch
