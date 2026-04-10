import { schemaValidateProvider } from '../providers/schema-validate.provider'
import type { StepProviderInput } from '../lib/types'

function makeInput(itemData: Record<string, unknown>, schema: Record<string, unknown>): StepProviderInput {
  return {
    itemId: 'test-item-1',
    itemIndex: 0,
    itemData,
    stepConfig: { schema },
    scope: { organizationId: 'org-1', tenantId: 'tenant-1' },
  }
}

describe('schema-validate provider', () => {
  it('returns success for valid data', async () => {
    const result = await schemaValidateProvider.processItem(
      makeInput(
        { name: 'Laptop', quantity: 5 },
        { name: { type: 'string', required: true }, quantity: { type: 'number', required: true, min: 0 } },
      ),
    )
    expect(result.status).toBe('success')
    expect(result.data).toEqual({ valid: true, errors: [] })
  })

  it('returns error for invalid data', async () => {
    const result = await schemaValidateProvider.processItem(
      makeInput(
        { name: '', quantity: -1 },
        { name: { type: 'string', required: true, minLength: 1 }, quantity: { type: 'number', required: true, min: 0 } },
      ),
    )
    expect(result.status).toBe('error')
    expect(result.error).toBe('Validation failed')
    expect(result.data?.valid).toBe(false)
  })

  it('returns error when schema is missing', async () => {
    const result = await schemaValidateProvider.processItem({
      itemId: 'test',
      itemIndex: 0,
      itemData: { a: 1 },
      stepConfig: {},
      scope: { organizationId: 'org-1', tenantId: 'tenant-1' },
    })
    expect(result.status).toBe('error')
    expect(result.error).toContain('Missing')
  })

  it('handles optional fields', async () => {
    const result = await schemaValidateProvider.processItem(
      makeInput(
        {},
        { name: { type: 'string' }, quantity: { type: 'number' } },
      ),
    )
    expect(result.status).toBe('success')
  })

  it('validates boolean type', async () => {
    const result = await schemaValidateProvider.processItem(
      makeInput(
        { active: true },
        { active: { type: 'boolean', required: true } },
      ),
    )
    expect(result.status).toBe('success')
  })

  it('rejects wrong type', async () => {
    const result = await schemaValidateProvider.processItem(
      makeInput(
        { quantity: 'not a number' },
        { quantity: { type: 'number', required: true } },
      ),
    )
    expect(result.status).toBe('error')
  })

  it('validates maxLength', async () => {
    const result = await schemaValidateProvider.processItem(
      makeInput(
        { code: 'ABCDEFGHIJ' },
        { code: { type: 'string', required: true, maxLength: 5 } },
      ),
    )
    expect(result.status).toBe('error')
  })

  it('validates max on number', async () => {
    const result = await schemaValidateProvider.processItem(
      makeInput(
        { score: 150 },
        { score: { type: 'number', required: true, max: 100 } },
      ),
    )
    expect(result.status).toBe('error')
  })
})
