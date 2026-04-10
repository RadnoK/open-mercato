import type { StepProvider, StepProviderInput, StepProviderResult } from '../lib/types'
import { interpolateTemplate, applyResponseMapping, interpolateDeep } from './utils'

export const httpWebhookProvider: StepProvider = {
  providerKey: 'http_webhook',
  displayName: 'HTTP Webhook',
  description: 'Call an external HTTP API with configurable URL, headers, body template, and response mapping',
  category: 'enrichment',

  async processItem(input: StepProviderInput): Promise<StepProviderResult> {
    const { itemData, stepConfig } = input
    const urlTemplate = stepConfig.url as string | undefined
    const method = (stepConfig.method as string) ?? 'POST'
    const timeout = (stepConfig.timeout as number) ?? 10000
    const headersConfig = (stepConfig.headers as Record<string, string>) ?? {}
    const bodyTemplate = stepConfig.bodyTemplate as Record<string, unknown> | undefined
    const responseMapping = (stepConfig.responseMapping as Record<string, string>) ?? {}

    if (!urlTemplate) {
      return { status: 'error', error: 'Missing "url" in providerConfig' }
    }

    const url = interpolateTemplate(urlTemplate, itemData)

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    for (const [key, valueTemplate] of Object.entries(headersConfig)) {
      headers[key] = interpolateTemplate(valueTemplate, itemData)
    }

    const body = bodyTemplate
      ? JSON.stringify(interpolateDeep(bodyTemplate, itemData))
      : undefined

    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeout),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'HTTP request failed'
      if (message.includes('abort') || message.includes('timeout')) {
        return { status: 'error', error: `Request timed out after ${timeout}ms` }
      }
      return { status: 'error', error: message }
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { status: 'error', error: `HTTP ${response.status}: ${text.slice(0, 500)}` }
    }

    let responseData: unknown
    try {
      responseData = await response.json()
    } catch {
      return { status: 'error', error: 'Response is not valid JSON' }
    }

    if (Object.keys(responseMapping).length > 0) {
      const mapped = applyResponseMapping(responseData, responseMapping)
      return { status: 'success', data: mapped }
    }

    return { status: 'success', data: responseData as Record<string, unknown> }
  },
}
