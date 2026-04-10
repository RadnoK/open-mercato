import { generateObject } from 'ai'
import { z } from 'zod'
import {
  resolveFirstConfiguredOpenCodeProvider,
  resolveOpenCodeModel,
  resolveOpenCodeProviderApiKey,
  resolveOpenCodeProviderId,
} from '@open-mercato/shared/lib/ai/opencode-provider'
import type { PipelineStepDefinition, StepProvider } from './types'
import { getAllStepProviders } from './provider-registry'

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

const pipelineOutputSchema = z.object({
  pipelineKey: z.string().describe('Unique key for the pipeline (lowercase, underscores)'),
  name: z.string().describe('Human-readable pipeline name'),
  description: z.string().describe('What this pipeline does'),
  steps: z.array(z.object({
    stepKey: z.string(),
    label: z.string(),
    type: z.enum(['automated', 'review', 'agent_review']),
    providerKey: z.string().optional(),
    providerConfig: z.record(z.string(), z.unknown()).optional(),
    inputMapping: z.record(z.string(), z.string()).optional(),
    outputMapping: z.record(z.string(), z.string()).optional(),
    optional: z.boolean().optional(),
    agentConfig: z.object({
      prompt: z.string(),
      autoApproveThreshold: z.number(),
      escalateToHumanBelow: z.number(),
      includeStepResults: z.boolean(),
      includeSuggestions: z.boolean(),
      strategy: z.enum(['pick_best', 'pick_if_confident', 'always_escalate', 'custom']),
    }).optional(),
    condition: z.object({
      field: z.string(),
      op: z.string(),
      value: z.unknown(),
    }).optional(),
  })),
  reasoning: z.string().describe('Why you designed the pipeline this way'),
})

export interface DesignPipelineInput {
  description: string
  itemSample?: Record<string, unknown>
  availableProviders: StepProvider[]
  preferences?: {
    includeAgentReview: boolean
    includeHumanReview: boolean
    maxStepCount: number
  }
}

export interface DesignPipelineOutput {
  pipelineKey: string
  name: string
  description: string
  steps: PipelineStepDefinition[]
  reasoning: string
}

export function createPipelineDesigner() {
  async function designPipeline(input: DesignPipelineInput): Promise<DesignPipelineOutput> {
    const providers = input.availableProviders.length > 0
      ? input.availableProviders
      : getAllStepProviders()

    const providerList = providers.map((p) =>
      `- ${p.providerKey} (${p.category}): ${p.displayName}${p.description ? ` — ${p.description}` : ''}`,
    ).join('\n')

    const maxSteps = input.preferences?.maxStepCount ?? 10

    const systemPrompt = `You are a pipeline architect for a batch item processing system.
Design an optimal processing pipeline based on the user's description.

AVAILABLE STEP PROVIDERS:
${providerList || '(none registered — use ai_transform with appropriate prompts)'}

AVAILABLE STEP TYPES:
- automated: Runs a registered provider on each item. Requires providerKey.
- review: Pauses pipeline for human review. No providerKey needed.
- agent_review: AI agent reviews items with confidence thresholds. Requires agentConfig.

DESIGN RULES:
- Use ai_translate before providers that need text in a specific language
- Use schema_validate early to catch bad data
- Place agent_review before human review to reduce human workload
- End with human review for safety (make it conditional on agent escalation)
- Keep pipeline under ${maxSteps} steps
- Use inputMapping/outputMapping for field chaining between steps
- stepKey must be lowercase with underscores
${input.preferences?.includeAgentReview === false ? '- Do NOT include agent_review steps' : ''}
${input.preferences?.includeHumanReview === false ? '- Do NOT include review steps' : ''}`

    let userPrompt = `Design a pipeline for: ${input.description}`
    if (input.itemSample) {
      userPrompt += `\n\nSample item:\n${JSON.stringify(input.itemSample, null, 2).slice(0, 1000)}`
    }

    const model = await resolveModel()

    const result = await generateObject({
      model,
      schema: pipelineOutputSchema,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0,
    })

    const output = result.object

    // Post-validate: ensure providerKeys exist
    const providerKeys = new Set(providers.map((p) => p.providerKey))
    const validatedSteps = output.steps.slice(0, maxSteps).map((step) => {
      if (step.type === 'automated' && step.providerKey && !providerKeys.has(step.providerKey)) {
        return {
          ...step,
          providerKey: 'ai_transform',
          providerConfig: {
            prompt: `Process this item as if using provider "${step.providerKey}": {{description}}`,
            outputSchema: { result: 'string' },
          },
        }
      }
      return step
    }) as PipelineStepDefinition[]

    return {
      pipelineKey: output.pipelineKey,
      name: output.name,
      description: output.description,
      steps: validatedSteps,
      reasoning: output.reasoning,
    }
  }

  return { designPipeline }
}

export type PipelineDesigner = ReturnType<typeof createPipelineDesigner>
