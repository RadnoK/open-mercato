import { z } from 'zod'
import { resolveDeep, interpolateTemplate } from '../lib/utils'

export { resolveDeep, interpolateTemplate }

/**
 * Build a Zod schema dynamically from a JSON config object.
 * Supported types: string, number, boolean, array.
 * Supports: required, minLength, maxLength, min, max.
 */
export function buildZodFromConfig(schema: Record<string, unknown>): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const [key, def] of Object.entries(schema)) {
    if (typeof def === 'string') {
      shape[key] = mapSimpleType(def)
      continue
    }

    if (typeof def === 'object' && def !== null) {
      const fieldDef = def as Record<string, unknown>
      let fieldSchema = mapSimpleType(String(fieldDef.type ?? 'string'))

      if (fieldSchema instanceof z.ZodString) {
        if (typeof fieldDef.minLength === 'number') fieldSchema = fieldSchema.min(fieldDef.minLength)
        if (typeof fieldDef.maxLength === 'number') fieldSchema = fieldSchema.max(fieldDef.maxLength)
      }
      if (fieldSchema instanceof z.ZodNumber) {
        if (typeof fieldDef.min === 'number') fieldSchema = fieldSchema.min(fieldDef.min)
        if (typeof fieldDef.max === 'number') fieldSchema = fieldSchema.max(fieldDef.max)
      }

      shape[key] = fieldDef.required ? fieldSchema : fieldSchema.optional()
      continue
    }

    shape[key] = z.string().optional()
  }

  return z.object(shape)
}

function mapSimpleType(type: string): z.ZodTypeAny {
  switch (type) {
    case 'string': return z.string()
    case 'number': return z.number()
    case 'boolean': return z.boolean()
    case 'array': return z.array(z.unknown())
    default: return z.string()
  }
}

/**
 * Apply response mapping: extract fields from a response using dot-notation paths.
 */
export function applyResponseMapping(
  response: unknown,
  mapping: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [targetKey, sourcePath] of Object.entries(mapping)) {
    result[targetKey] = resolveDeep(response, sourcePath)
  }
  return result
}

/**
 * Recursively interpolate all string values in an object tree.
 */
export function interpolateDeep(obj: unknown, data: Record<string, unknown>): unknown {
  if (typeof obj === 'string') return interpolateTemplate(obj, data)
  if (Array.isArray(obj)) return obj.map((item) => interpolateDeep(item, data))
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateDeep(value, data)
    }
    return result
  }
  return obj
}
