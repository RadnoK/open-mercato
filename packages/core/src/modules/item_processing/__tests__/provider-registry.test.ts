import { registerStepProvider, getStepProvider, getAllStepProviders } from '../lib/provider-registry'
import type { StepProvider } from '../lib/types'

const mockProvider = (key: string): StepProvider => ({
  providerKey: key,
  displayName: `Mock ${key}`,
  category: 'transformation',
  async processItem() {
    return { status: 'success', data: {} }
  },
})

describe('provider-registry', () => {
  it('registers and retrieves a provider', () => {
    const provider = mockProvider('test_reg_1')
    registerStepProvider(provider)
    expect(getStepProvider('test_reg_1')).toBe(provider)
  })

  it('returns undefined for unknown provider', () => {
    expect(getStepProvider('nonexistent_provider_xyz')).toBeUndefined()
  })

  it('overwrites duplicate providerKey with warning', () => {
    const first = mockProvider('test_dup')
    const second = mockProvider('test_dup')
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation()

    registerStepProvider(first)
    registerStepProvider(second)

    expect(getStepProvider('test_dup')).toBe(second)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('test_dup'))
    warnSpy.mockRestore()
  })

  it('getAllStepProviders returns all registered', () => {
    registerStepProvider(mockProvider('test_all_1'))
    registerStepProvider(mockProvider('test_all_2'))

    const all = getAllStepProviders()
    const keys = all.map((p) => p.providerKey)
    expect(keys).toContain('test_all_1')
    expect(keys).toContain('test_all_2')
  })
})
