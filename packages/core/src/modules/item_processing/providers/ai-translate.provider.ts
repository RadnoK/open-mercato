import { generateText } from 'ai'
import {
  resolveFirstConfiguredOpenCodeProvider,
  resolveOpenCodeModel,
  resolveOpenCodeProviderApiKey,
  resolveOpenCodeProviderId,
} from '@open-mercato/shared/lib/ai/opencode-provider'
import type { StepProvider, StepProviderInput, StepProviderResult } from '../lib/types'

async function resolveModel(): Promise<Parameters<typeof generateText>[0]['model']> {
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
      return createAnthropic({ apiKey })(modelConfig.modelId) as any
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai')
      return createOpenAI({ apiKey })(modelConfig.modelId) as any
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      return createGoogleGenerativeAI({ apiKey })(modelConfig.modelId) as any
    }
    default:
      throw new Error(`Unsupported AI provider: ${providerId}`)
  }
}

export const aiTranslateProvider: StepProvider = {
  providerKey: 'ai_translate',
  displayName: 'AI Translate',
  description: 'Translate item fields to a target language using AI',
  category: 'transformation',

  async processItem(input: StepProviderInput): Promise<StepProviderResult> {
    const { itemData, stepConfig } = input
    const targetLang = stepConfig.targetLang as string | undefined
    const fields = (stepConfig.fields as string[] | undefined) ?? Object.keys(itemData)

    if (!targetLang) {
      return { status: 'error', error: 'Missing "targetLang" in providerConfig' }
    }

    const model = await resolveModel()
    const translations: Record<string, string> = {}

    for (const field of fields) {
      const value = itemData[field]
      if (!value || typeof value !== 'string' || !value.trim()) continue

      const result = await generateText({
        model,
        prompt: `Translate the following text to ${targetLang}. Return ONLY the translation, nothing else:\n\n${value}`,
        temperature: 0,
      })

      const translated = result.text.trim()
      if (translated) {
        translations[`${field}_${targetLang}`] = translated
      }
    }

    return { status: 'success', data: translations }
  },
}
