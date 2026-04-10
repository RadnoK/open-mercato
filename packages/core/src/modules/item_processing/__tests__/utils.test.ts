import { resolveDeep, interpolateTemplate, sleep } from '../lib/utils'
import { buildZodFromConfig, applyResponseMapping, interpolateDeep } from '../providers/utils'

describe('resolveDeep', () => {
  it('resolves simple path', () => {
    expect(resolveDeep({ name: 'test' }, 'name')).toBe('test')
  })

  it('resolves nested path', () => {
    expect(resolveDeep({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42)
  })

  it('returns undefined for missing path', () => {
    expect(resolveDeep({ a: 1 }, 'b')).toBeUndefined()
  })

  it('returns undefined for missing nested path', () => {
    expect(resolveDeep({ a: { b: 1 } }, 'a.c.d')).toBeUndefined()
  })

  it('returns undefined for null input', () => {
    expect(resolveDeep(null, 'a')).toBeUndefined()
  })

  it('returns undefined for undefined input', () => {
    expect(resolveDeep(undefined, 'a')).toBeUndefined()
  })

  it('handles null intermediate value', () => {
    expect(resolveDeep({ a: null }, 'a.b')).toBeUndefined()
  })
})

describe('interpolateTemplate', () => {
  it('replaces simple field', () => {
    expect(interpolateTemplate('Hello {{name}}', { name: 'World' })).toBe('Hello World')
  })

  it('replaces nested field', () => {
    expect(interpolateTemplate('Value: {{a.b}}', { a: { b: 42 } })).toBe('Value: 42')
  })

  it('replaces missing field with empty string', () => {
    expect(interpolateTemplate('Hello {{missing}}', {})).toBe('Hello ')
  })

  it('replaces null field with empty string', () => {
    expect(interpolateTemplate('Hello {{name}}', { name: null })).toBe('Hello ')
  })

  it('replaces env variables', () => {
    process.env.TEST_VAR_123 = 'test_value'
    expect(interpolateTemplate('Key: {{env.TEST_VAR_123}}', {})).toBe('Key: test_value')
    delete process.env.TEST_VAR_123
  })

  it('replaces missing env with empty string', () => {
    expect(interpolateTemplate('Key: {{env.NONEXISTENT_VAR_XYZ}}', {})).toBe('Key: ')
  })

  it('handles multiple replacements', () => {
    expect(interpolateTemplate('{{a}} and {{b}}', { a: 'foo', b: 'bar' })).toBe('foo and bar')
  })

  it('handles no placeholders', () => {
    expect(interpolateTemplate('no placeholders here', { a: 1 })).toBe('no placeholders here')
  })
})

describe('buildZodFromConfig', () => {
  it('builds schema with simple string types', () => {
    const schema = buildZodFromConfig({ category: 'string', count: 'number' })
    expect(schema.safeParse({ category: 'test', count: 5 }).success).toBe(true)
  })

  it('builds schema with object field definitions', () => {
    const schema = buildZodFromConfig({
      name: { type: 'string', required: true, minLength: 1 },
      quantity: { type: 'number', required: true, min: 0 },
    })
    expect(schema.safeParse({ name: 'test', quantity: 5 }).success).toBe(true)
    expect(schema.safeParse({ name: '', quantity: 5 }).success).toBe(false)
    expect(schema.safeParse({ name: 'test', quantity: -1 }).success).toBe(false)
  })

  it('makes fields optional when required is not set', () => {
    const schema = buildZodFromConfig({
      name: { type: 'string' },
    })
    expect(schema.safeParse({}).success).toBe(true)
  })

  it('handles boolean type', () => {
    const schema = buildZodFromConfig({ active: 'boolean' })
    expect(schema.safeParse({ active: true }).success).toBe(true)
    expect(schema.safeParse({ active: 'yes' }).success).toBe(false)
  })

  it('handles unknown types as string', () => {
    const schema = buildZodFromConfig({ field: 'unknowntype' })
    expect(schema.safeParse({ field: 'test' }).success).toBe(true)
  })
})

describe('applyResponseMapping', () => {
  it('maps flat fields', () => {
    const response = { code: '8471', name: 'Computers' }
    const mapping = { hsCode: 'code', hsName: 'name' }
    expect(applyResponseMapping(response, mapping)).toEqual({ hsCode: '8471', hsName: 'Computers' })
  })

  it('maps nested fields', () => {
    const response = { result: { items: [{ code: '8471' }] } }
    const mapping = { firstCode: 'result.items' }
    const result = applyResponseMapping(response, mapping)
    expect(result.firstCode).toEqual([{ code: '8471' }])
  })

  it('returns undefined for missing paths', () => {
    const result = applyResponseMapping({ a: 1 }, { b: 'missing.path' })
    expect(result.b).toBeUndefined()
  })
})

describe('interpolateDeep', () => {
  it('interpolates strings in objects', () => {
    const result = interpolateDeep({ query: '{{name}}', lang: 'pl' }, { name: 'test' })
    expect(result).toEqual({ query: 'test', lang: 'pl' })
  })

  it('interpolates nested objects', () => {
    const result = interpolateDeep({ body: { text: '{{desc}}' } }, { desc: 'hello' })
    expect(result).toEqual({ body: { text: 'hello' } })
  })

  it('interpolates arrays', () => {
    const result = interpolateDeep(['{{a}}', '{{b}}'], { a: 'x', b: 'y' })
    expect(result).toEqual(['x', 'y'])
  })

  it('passes through non-string values', () => {
    const result = interpolateDeep({ count: 5, active: true }, {})
    expect(result).toEqual({ count: 5, active: true })
  })
})

describe('sleep', () => {
  it('resolves after delay', async () => {
    const start = Date.now()
    await sleep(50)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(40)
  })
})
