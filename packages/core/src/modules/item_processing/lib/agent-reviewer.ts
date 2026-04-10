import { generateObject } from 'ai'
import { z } from 'zod'
import {
  resolveFirstConfiguredOpenCodeProvider,
  resolveOpenCodeModel,
  resolveOpenCodeProviderApiKey,
  resolveOpenCodeProviderId,
} from '@open-mercato/shared/lib/ai/opencode-provider'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ProcessingItem } from '../data/entities'
import { emitItemProcessingEvent } from '../events'
import type {
  AgentReviewConfig,
  AgentReviewResult,
  AgentFinalDecision,
  PipelineStepDefinition,
  StepSuggestion,
  TenantScope,
} from './types'

// ─── AI Model Resolution ────────────────────────────────────────────────────

type AiModel = Parameters<typeof generateObject>[0]['model']

async function resolveModel(): Promise<AiModel> {
  const configuredProvider = process.env.OPENCODE_PROVIDER
  const providerId = configuredProvider?.trim()
    ? resolveOpenCodeProviderId(configuredProvider)
    : resolveFirstConfiguredOpenCodeProvider() ?? resolveOpenCodeProviderId(undefined)

  const apiKey = resolveOpenCodeProviderApiKey(providerId)
  if (!apiKey) throw new Error(`Missing API key for AI provider "${providerId}"`)

  const modelConfig = resolveOpenCodeModel(providerId, {})

  switch (providerId) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic')
      return createAnthropic({ apiKey })(modelConfig.modelId) as AiModel
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai')
      return createOpenAI({ apiKey })(modelConfig.modelId) as AiModel
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      return createGoogleGenerativeAI({ apiKey })(modelConfig.modelId) as AiModel
    }
    default:
      throw new Error(`Unsupported AI provider: ${providerId}`)
  }
}

// ─── Output Schema ──────────────────────────────────────────────────────────

const agentDecisionSchema = z.object({
  selectedSuggestionId: z.string().nullable().describe('ID of the chosen suggestion, or null if no suggestion fits'),
  selectedValue: z.record(z.string(), z.unknown()).nullable().describe('Custom value if not picking from suggestions'),
  confidence: z.number().min(0).max(100).describe('How confident you are in this decision (0-100)'),
  reasoning: z.string().describe('Brief explanation of why you made this choice'),
  needsHumanReview: z.boolean().describe('True if you think a human should verify this decision'),
  notes: z.string().nullable().describe('Additional context or caveats'),
})

type AgentDecision = z.infer<typeof agentDecisionSchema>

// ─── Prompt Building ────────────────────────────────────────────────────────

function buildSystemPrompt(agentConfig: AgentReviewConfig, pipelineContext: { pipelineName: string; stepKey: string }): string {
  return `You are an expert reviewer evaluating batch processing results.
You must analyze the item data and previous step results, then make a decision.

PIPELINE: ${pipelineContext.pipelineName}
DECISION STEP: ${pipelineContext.stepKey}

YOUR INSTRUCTIONS:
${agentConfig.prompt}

Respond with a structured decision. Be precise about your confidence level.
If you are unsure, set needsHumanReview to true and explain why in reasoning.`
}

function buildUserPrompt(
  item: ProcessingItem,
  agentConfig: AgentReviewConfig,
  suggestions: StepSuggestion[],
): string {
  const parts: string[] = []

  const inputStr = JSON.stringify(item.inputData, null, 2).slice(0, 3000)
  parts.push(`ITEM DATA:\n${inputStr}`)

  if (item.outputData && Object.keys(item.outputData).length > 0) {
    const outputStr = JSON.stringify(item.outputData, null, 2).slice(0, 2000)
    parts.push(`ENRICHED DATA (from previous steps):\n${outputStr}`)
  }

  if (agentConfig.includeStepResults && item.stepResults) {
    const resultsStr = JSON.stringify(item.stepResults, null, 2).slice(0, 3000)
    parts.push(`PREVIOUS STEP RESULTS:\n${resultsStr}`)
  }

  if (agentConfig.includeSuggestions && suggestions.length > 0) {
    const suggestionsStr = suggestions.map((s, i) =>
      `  ${i + 1}. [${s.id}] ${s.label}${s.confidence != null ? ` (confidence: ${s.confidence}%)` : ''}${s.description ? ` — ${s.description}` : ''}`,
    ).join('\n')
    parts.push(`AVAILABLE SUGGESTIONS:\n${suggestionsStr}`)
  }

  parts.push('Make your decision based on the above data.')

  return parts.join('\n\n')
}

function extractSuggestions(item: ProcessingItem): StepSuggestion[] {
  if (!item.stepResults) return []
  for (const result of Object.values(item.stepResults)) {
    const r = result as Record<string, unknown> | null
    if (r?.suggestions && Array.isArray(r.suggestions) && r.suggestions.length > 0) {
      return r.suggestions as StepSuggestion[]
    }
  }
  return []
}

// ─── Agent Reviewer ─────────────────────────────────────────────────────────

export function createAgentReviewer() {
  async function reviewItem(
    item: ProcessingItem,
    agentConfig: AgentReviewConfig,
    pipelineContext: { pipelineName: string; stepKey: string },
  ): Promise<AgentDecision> {
    const suggestions = extractSuggestions(item)

    const model = await resolveModel()
    const systemPrompt = buildSystemPrompt(agentConfig, pipelineContext)
    const userPrompt = buildUserPrompt(item, agentConfig, suggestions)

    const result = await generateObject({
      model,
      schema: agentDecisionSchema,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0,
    })

    const decision = result.object

    // Apply strategy modifiers
    switch (agentConfig.strategy) {
      case 'pick_best':
        if (!decision.selectedSuggestionId && suggestions.length > 0) {
          decision.selectedSuggestionId = suggestions[0].id
          decision.selectedValue = suggestions[0].value
        }
        break
      case 'always_escalate':
        decision.needsHumanReview = true
        break
      case 'pick_if_confident':
      case 'custom':
        break
    }

    // Validate selectedSuggestionId exists in suggestions
    if (decision.selectedSuggestionId && suggestions.length > 0) {
      const exists = suggestions.some((s) => s.id === decision.selectedSuggestionId)
      if (!exists) {
        console.warn(`[item-processing] Agent selected non-existent suggestion "${decision.selectedSuggestionId}", forcing escalation`)
        decision.needsHumanReview = true
      }
    }

    // Resolve selectedValue from suggestion if not set
    if (decision.selectedSuggestionId && !decision.selectedValue) {
      const suggestion = suggestions.find((s) => s.id === decision.selectedSuggestionId)
      if (suggestion) decision.selectedValue = suggestion.value
    }

    // Clamp confidence
    decision.confidence = Math.max(0, Math.min(100, decision.confidence))

    return decision
  }

  async function processStep(
    em: EntityManager,
    jobId: string,
    step: PipelineStepDefinition,
    items: ProcessingItem[],
    scope: TenantScope,
  ): Promise<{ totalReviewed: number; autoApproved: number; escalated: number; hasEscalated: boolean }> {
    const agentConfig = step.agentConfig!
    let autoApprovalCount = 0
    let escalatedCount = 0
    const maxAutoApprovals = agentConfig.maxAutoApprovals ?? Number.MAX_SAFE_INTEGER

    for (const item of items) {
      const decision = await reviewItem(item, agentConfig, {
        pipelineName: `Job ${jobId}`,
        stepKey: step.stepKey,
      })

      const now = new Date().toISOString()
      let finalDecision: AgentFinalDecision
      let decidedBy: AgentReviewResult['decidedBy']

      if (
        decision.confidence >= agentConfig.autoApproveThreshold
        && !decision.needsHumanReview
        && autoApprovalCount < maxAutoApprovals
      ) {
        // Auto-approve
        finalDecision = 'auto_approved'
        decidedBy = 'agent'
        autoApprovalCount++

        const selectedValues = {
          ...(item.selectedValues ?? {}),
          [step.stepKey]: decision.selectedValue ?? { suggestionId: decision.selectedSuggestionId },
        }
        await em.nativeUpdate(ProcessingItem, { id: item.id }, { selectedValues })

        await emitItemProcessingEvent('item_processing.item.agent_decided', {
          jobId,
          itemId: item.id,
          confidence: decision.confidence,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        })
      } else if (
        decision.confidence < agentConfig.escalateToHumanBelow
        || decision.needsHumanReview
        || autoApprovalCount >= maxAutoApprovals
      ) {
        // Escalate to human
        finalDecision = 'escalated'
        decidedBy = 'agent_escalated_to_human'
        escalatedCount++

        await em.nativeUpdate(ProcessingItem, { id: item.id }, {
          status: 'awaiting_review',
          currentStep: step.stepKey,
        })

        await emitItemProcessingEvent('item_processing.item.agent_escalated', {
          jobId,
          itemId: item.id,
          confidence: decision.confidence,
          reasoning: decision.reasoning,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        })
      } else {
        // Between thresholds — auto-approve with spot-check flag
        finalDecision = 'spot_check'
        decidedBy = 'agent'
        autoApprovalCount++

        const selectedValues = {
          ...(item.selectedValues ?? {}),
          [step.stepKey]: decision.selectedValue ?? { suggestionId: decision.selectedSuggestionId },
        }
        await em.nativeUpdate(ProcessingItem, { id: item.id }, { selectedValues })

        await emitItemProcessingEvent('item_processing.item.agent_decided', {
          jobId,
          itemId: item.id,
          confidence: decision.confidence,
          flaggedForReview: true,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        })
      }

      // Save audit trail
      const agentResult: AgentReviewResult = {
        decidedBy,
        agentConfidence: decision.confidence,
        agentReasoning: decision.reasoning,
        agentSelectedSuggestionId: decision.selectedSuggestionId,
        agentNotes: decision.notes,
        humanOverride: false,
        humanSelectedSuggestionId: null,
        finalDecision,
        decidedAt: now,
      }

      const stepResults = {
        ...(item.stepResults ?? {}),
        [step.stepKey]: agentResult,
      }
      await em.nativeUpdate(ProcessingItem, { id: item.id }, { stepResults })
    }

    return {
      totalReviewed: items.length,
      autoApproved: autoApprovalCount,
      escalated: escalatedCount,
      hasEscalated: escalatedCount > 0,
    }
  }

  return { reviewItem, processStep }
}

export type AgentReviewer = ReturnType<typeof createAgentReviewer>
