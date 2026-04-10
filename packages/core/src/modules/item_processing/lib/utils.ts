/**
 * Resolve a dot-notation path on an object.
 * e.g. resolveDeep({ a: { b: 42 } }, 'a.b') => 42
 * Returns undefined if any segment is missing.
 */
export function resolveDeep(obj: unknown, dotPath: string): unknown {
  if (obj === null || obj === undefined) return undefined

  const segments = dotPath.split('.')
  let current: unknown = obj

  for (const segment of segments) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }

  return current
}

/**
 * Interpolate {{field}} and {{env.VAR}} placeholders in a template string.
 * Unknown fields resolve to empty string.
 */
export function interpolateTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_match, path: string) => {
    const trimmed = path.trim()

    if (trimmed.startsWith('env.')) {
      const envVar = trimmed.slice(4)
      return process.env[envVar] ?? ''
    }

    const resolved = resolveDeep(data, trimmed)
    if (resolved === null || resolved === undefined) return ''
    return String(resolved)
  })
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

/**
 * Apply response mapping: extract fields from a response object using dot-notation paths.
 * e.g. applyResponseMapping({ result: { code: '8471' } }, { hsCode: 'result.code' })
 * => { hsCode: '8471' }
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
 * Simple sleep for retry backoff.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
