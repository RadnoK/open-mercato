import type { StepProvider, StepProviderInput, StepProviderResult } from '../lib/types'
import { buildZodFromConfig } from './utils'

export const schemaValidateProvider: StepProvider = {
  providerKey: 'schema_validate',
  displayName: 'Schema Validate',
  description: 'Validate item data against a JSON schema definition',
  category: 'validation',

  async processItem(input: StepProviderInput): Promise<StepProviderResult> {
    const schema = input.stepConfig.schema as Record<string, unknown> | undefined
    if (!schema || Object.keys(schema).length === 0) {
      return { status: 'error', error: 'Missing "schema" in providerConfig' }
    }

    const zodSchema = buildZodFromConfig(schema)
    const result = zodSchema.safeParse(input.itemData)

    if (result.success) {
      return { status: 'success', data: { valid: true, errors: [] } }
    }

    return {
      status: 'error',
      error: 'Validation failed',
      data: { valid: false, errors: result.error.flatten().fieldErrors },
    }
  },
}
