import type { StepProvider } from './types'

const providers = new Map<string, StepProvider>()

export function registerStepProvider(provider: StepProvider): void {
  if (providers.has(provider.providerKey)) {
    console.warn(`[item-processing] StepProvider "${provider.providerKey}" already registered, overwriting`)
  }
  providers.set(provider.providerKey, provider)
}

export function getStepProvider(providerKey: string): StepProvider | undefined {
  return providers.get(providerKey)
}

export function getAllStepProviders(): StepProvider[] {
  return Array.from(providers.values())
}
