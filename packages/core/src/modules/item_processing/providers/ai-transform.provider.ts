import { generateObject, generateText } from 'ai'
import {
  resolveFirstConfiguredOpenCodeProvider,
  resolveOpenCodeModel,
  resolveOpenCodeProviderApiKey,
  resolveOpenCodeProviderId,
} from '@open-mercato/shared/lib/ai/opencode-provider'
import type { StepProvider, StepProviderInput, StepProviderResult } from '../lib/types'
import { interpolateTemplate, buildZodFromConfig } from './utils'

type AiModel = Parameters<typeof generateObject>[0]['model']

async function resolveModel(modelOverride?: string): Promise<AiModel> {
  const configuredProvider = process.env.OPENCODE_PROVIDER
  const providerId = configuredProvider?.trim()
    ? resolveOpenCodeProviderId(configuredProvider)
    : resolveFirstConfiguredOpenCodeProvider() ?? resolveOpenCodeProviderId(undefined)

  const apiKey = resolveOpenCodeProviderApiKey(providerId)
  if (!apiKey) throw new Error(`Missing API key for AI provider "${providerId}"`)

  const modelConfig = resolveOpenCodeModel(providerId, {
    overrideModel: modelOverride,
  })

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

export const aiTransformProvider: StepProvider = {
  providerKey: 'ai_transform',
  displayName: 'AI Transform',
  description: 'Generic AI processing with prompt template and structured output',
  category: 'transformation',

  async processItem(input: StepProviderInput): Promise<StepProviderResult> {
    const { itemData, stepConfig } = input
    const prompt = stepConfig.prompt as string | undefined
    const outputSchema = stepConfig.outputSchema as Record<string, unknown> | undefined
    const modelOverride = stepConfig.model as string | undefined

    if (!prompt) {
      return { status: 'error', error: 'Missing "prompt" in providerConfig' }
    }

    const interpolatedPrompt = interpolateTemplate(prompt, itemData)
    const model = await resolveModel(modelOverride)

    if (outputSchema && Object.keys(outputSchema).length > 0) {
      const zodSchema = buildZodFromConfig(outputSchema)
      const result = await generateObject({
        model,
        schema: zodSchema,
        prompt: interpolatedPrompt,
        temperature: 0,
      })
      return { status: 'success', data: result.object as Record<string, unknown> }
    }

    const result = await generateText({
      model: model as Parameters<typeof generateText>[0]['model'],
      prompt: interpolatedPrompt,
      temperature: 0,
    })
    return { status: 'success', data: { text: result.text } }
  },
}
