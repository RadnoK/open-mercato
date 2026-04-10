import type { StepCondition } from './types'
import { resolveDeep } from './utils'

/**
 * Evaluate a StepCondition (or array of conditions) against step_results.
 * Returns true if the step should execute for this item.
 *
 * - undefined/null condition => true (no condition = always run)
 * - Array of conditions => AND logic (all must be true)
 * - Empty array => true
 */
export function evaluateCondition(
  condition: StepCondition | StepCondition[] | undefined | null,
  stepResults: Record<string, unknown>,
): boolean {
  if (condition === undefined || condition === null) return true

  const conditions = Array.isArray(condition) ? condition : [condition]
  if (conditions.length === 0) return true

  return conditions.every((c) => evaluateSingle(c, stepResults))
}

function evaluateSingle(condition: StepCondition, stepResults: Record<string, unknown>): boolean {
  const resolved = resolveDeep(stepResults, condition.field)

  switch (condition.op) {
    case 'exists':
      return resolved !== undefined && resolved !== null

    case 'eq':
      return resolved === condition.value

    case 'neq':
      return resolved !== condition.value

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return compareNumeric(resolved, condition.value, condition.op)

    case 'contains': {
      if (resolved === undefined || resolved === null) return false
      if (condition.value === undefined || condition.value === null) return false
      return String(resolved).includes(String(condition.value))
    }

    default:
      return false
  }
}

function compareNumeric(resolved: unknown, value: unknown, op: 'gt' | 'gte' | 'lt' | 'lte'): boolean {
  const numResolved = toNumber(resolved)
  const numValue = toNumber(value)

  if (numResolved === null || numValue === null) return false

  switch (op) {
    case 'gt': return numResolved > numValue
    case 'gte': return numResolved >= numValue
    case 'lt': return numResolved < numValue
    case 'lte': return numResolved <= numValue
  }
}

function toNumber(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val
  if (typeof val === 'string') {
    const parsed = Number.parseFloat(val)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
