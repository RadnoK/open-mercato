import { generateObject } from 'ai'
import { z } from 'zod'
import {
  resolveFirstConfiguredOpenCodeProvider,
  resolveOpenCodeModel,
  resolveOpenCodeProviderApiKey,
  resolveOpenCodeProviderId,
} from '@open-mercato/shared/lib/ai/opencode-provider'
import type { ProcessingItem } from '../data/entities'
import type { TenantScope } from './types'

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

const anomalyReportSchema = z.object({
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

export type AnomalyReport = z.infer<typeof anomalyReportSchema>

export function createAnomalyDetector() {
  async function analyzeJob(
    jobId: string,
    items: ProcessingItem[],
    scope: TenantScope,
  ): Promise<AnomalyReport> {
    if (items.length < 3) {
      return {
        anomalies: [],
        summary: { totalItems: items.length, anomalousItems: 0, overallQuality: 'good', keyInsight: 'Too few items for meaningful analysis' },
      }
    }

    const statusCounts: Record<string, number> = {}
    for (const item of items) {
      statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1
    }

    const hasAgentReview = items.some((item) => {
      if (!item.stepResults) return false
      return Object.values(item.stepResults).some((r: any) => r?.decidedBy != null)
    })

    const sampleItems = items.slice(0, 50).map((item) => ({
      id: item.id,
      index: item.itemIndex,
      status: item.status,
      inputSummary: JSON.stringify(item.inputData).slice(0, 200),
      outputSummary: item.outputData ? JSON.stringify(item.outputData).slice(0, 200) : null,
      stepResults: item.stepResults ? JSON.stringify(item.stepResults).slice(0, 500) : null,
      selectedValues: item.selectedValues ? JSON.stringify(item.selectedValues).slice(0, 200) : null,
      error: item.errorMessage,
    }))

    const systemPrompt = `You are a quality analyst reviewing batch processing results.
Analyze the data for anomalies and inconsistencies.

Look for:
- Similar items classified differently (inconsistent decisions)
- Unusually low or high confidence outliers compared to the batch average
${hasAgentReview ? '- Cases where AI agent and human disagreed (agent_human_disagreement)' : ''}
- Duplicate or near-duplicate items
- Patterns suggesting systematic errors (same failure reason across items)

Be specific about which items are affected (use their IDs).
Only report genuine anomalies — do not flag normal variation.`

    const userPrompt = `JOB: ${jobId}
TOTAL ITEMS: ${items.length}
STATUS BREAKDOWN: ${JSON.stringify(statusCounts)}

ITEM SAMPLES (up to 50):
${JSON.stringify(sampleItems, null, 2).slice(0, 8000)}`

    try {
      const model = await resolveModel()
      const result = await generateObject({
        model,
        schema: anomalyReportSchema,
        system: systemPrompt,
        prompt: userPrompt,
        temperature: 0,
      })

      return result.object
    } catch (err) {
      console.warn('[item-processing] Anomaly detection failed:', err instanceof Error ? err.message : err)
      return {
        anomalies: [],
        summary: { totalItems: items.length, anomalousItems: 0, overallQuality: 'acceptable', keyInsight: 'Anomaly detection could not complete' },
      }
    }
  }

  return { analyzeJob }
}

export type AnomalyDetector = ReturnType<typeof createAnomalyDetector>
