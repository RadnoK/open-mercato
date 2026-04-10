import { evaluateCondition } from '../lib/condition-evaluator'

describe('evaluateCondition', () => {
  describe('undefined/null/empty conditions', () => {
    it('returns true for undefined condition', () => {
      expect(evaluateCondition(undefined, {})).toBe(true)
    })

    it('returns true for null condition', () => {
      expect(evaluateCondition(null, {})).toBe(true)
    })

    it('returns true for empty array', () => {
      expect(evaluateCondition([], {})).toBe(true)
    })
  })

  describe('eq operator', () => {
    it('matches equal values', () => {
      expect(evaluateCondition({ field: 'status', op: 'eq', value: 'completed' }, { status: 'completed' })).toBe(true)
    })

    it('rejects non-equal values', () => {
      expect(evaluateCondition({ field: 'status', op: 'eq', value: 'completed' }, { status: 'pending' })).toBe(false)
    })

    it('matches numeric values', () => {
      expect(evaluateCondition({ field: 'count', op: 'eq', value: 5 }, { count: 5 })).toBe(true)
    })
  })

  describe('neq operator', () => {
    it('matches non-equal values', () => {
      expect(evaluateCondition({ field: 'status', op: 'neq', value: 'failed' }, { status: 'completed' })).toBe(true)
    })

    it('rejects equal values', () => {
      expect(evaluateCondition({ field: 'status', op: 'neq', value: 'failed' }, { status: 'failed' })).toBe(false)
    })
  })

  describe('numeric operators (gt, gte, lt, lte)', () => {
    it('gt: greater than', () => {
      expect(evaluateCondition({ field: 'confidence', op: 'gt', value: 70 }, { confidence: 85 })).toBe(true)
      expect(evaluateCondition({ field: 'confidence', op: 'gt', value: 70 }, { confidence: 70 })).toBe(false)
      expect(evaluateCondition({ field: 'confidence', op: 'gt', value: 70 }, { confidence: 50 })).toBe(false)
    })

    it('gte: greater than or equal', () => {
      expect(evaluateCondition({ field: 'confidence', op: 'gte', value: 70 }, { confidence: 70 })).toBe(true)
      expect(evaluateCondition({ field: 'confidence', op: 'gte', value: 70 }, { confidence: 85 })).toBe(true)
      expect(evaluateCondition({ field: 'confidence', op: 'gte', value: 70 }, { confidence: 50 })).toBe(false)
    })

    it('lt: less than', () => {
      expect(evaluateCondition({ field: 'confidence', op: 'lt', value: 70 }, { confidence: 50 })).toBe(true)
      expect(evaluateCondition({ field: 'confidence', op: 'lt', value: 70 }, { confidence: 70 })).toBe(false)
    })

    it('lte: less than or equal', () => {
      expect(evaluateCondition({ field: 'confidence', op: 'lte', value: 70 }, { confidence: 70 })).toBe(true)
      expect(evaluateCondition({ field: 'confidence', op: 'lte', value: 70 }, { confidence: 50 })).toBe(true)
      expect(evaluateCondition({ field: 'confidence', op: 'lte', value: 70 }, { confidence: 85 })).toBe(false)
    })

    it('returns false for non-numeric values', () => {
      expect(evaluateCondition({ field: 'name', op: 'gt', value: 70 }, { name: 'hello' })).toBe(false)
    })

    it('handles string numbers', () => {
      expect(evaluateCondition({ field: 'score', op: 'gt', value: 50 }, { score: '75' })).toBe(true)
    })
  })

  describe('exists operator', () => {
    it('returns true when field exists and is non-null', () => {
      expect(evaluateCondition({ field: 'name', op: 'exists', value: true }, { name: 'test' })).toBe(true)
    })

    it('returns false when field is undefined', () => {
      expect(evaluateCondition({ field: 'missing', op: 'exists', value: true }, {})).toBe(false)
    })

    it('returns false when field is null', () => {
      expect(evaluateCondition({ field: 'name', op: 'exists', value: true }, { name: null })).toBe(false)
    })
  })

  describe('contains operator', () => {
    it('matches substring', () => {
      expect(evaluateCondition({ field: 'desc', op: 'contains', value: 'laptop' }, { desc: 'Portable laptop computer' })).toBe(true)
    })

    it('rejects non-matching', () => {
      expect(evaluateCondition({ field: 'desc', op: 'contains', value: 'phone' }, { desc: 'Portable laptop' })).toBe(false)
    })

    it('returns false for null field', () => {
      expect(evaluateCondition({ field: 'desc', op: 'contains', value: 'test' }, { desc: null })).toBe(false)
    })
  })

  describe('deep nested paths', () => {
    it('resolves dot-notation paths', () => {
      const stepResults = {
        classify_hs: { confidence: 85, status: 'needs_review' },
      }
      expect(evaluateCondition({ field: 'classify_hs.confidence', op: 'gt', value: 70 }, stepResults)).toBe(true)
    })

    it('resolves deeply nested paths', () => {
      const data = { step1: { data: { category: 'electronics' } } }
      expect(evaluateCondition({ field: 'step1.data.category', op: 'eq', value: 'electronics' }, data)).toBe(true)
    })

    it('returns false for missing nested path', () => {
      expect(evaluateCondition({ field: 'missing.path.here', op: 'eq', value: 'test' }, {})).toBe(false)
    })
  })

  describe('array conditions (AND logic)', () => {
    it('all conditions must be true', () => {
      const conditions = [
        { field: 'classify.confidence', op: 'gt' as const, value: 50 },
        { field: 'classify.status', op: 'eq' as const, value: 'needs_review' },
      ]
      const data = { classify: { confidence: 85, status: 'needs_review' } }
      expect(evaluateCondition(conditions, data)).toBe(true)
    })

    it('returns false if any condition fails', () => {
      const conditions = [
        { field: 'classify.confidence', op: 'gt' as const, value: 90 },
        { field: 'classify.status', op: 'eq' as const, value: 'needs_review' },
      ]
      const data = { classify: { confidence: 85, status: 'needs_review' } }
      expect(evaluateCondition(conditions, data)).toBe(false)
    })
  })

  describe('real-world: agent_review conditional step', () => {
    it('skips human_review when agent auto-approved', () => {
      const condition = { field: 'agent_review.finalDecision', op: 'eq' as const, value: 'escalated' }
      const stepResults = { agent_review: { finalDecision: 'auto_approved', agentConfidence: 92 } }
      expect(evaluateCondition(condition, stepResults)).toBe(false)
    })

    it('runs human_review when agent escalated', () => {
      const condition = { field: 'agent_review.finalDecision', op: 'eq' as const, value: 'escalated' }
      const stepResults = { agent_review: { finalDecision: 'escalated', agentConfidence: 45 } }
      expect(evaluateCondition(condition, stepResults)).toBe(true)
    })

    it('runs AI fallback when confidence is low', () => {
      const condition = { field: 'classify_hs.confidence', op: 'lt' as const, value: 50 }
      const stepResults = { classify_hs: { confidence: 30, status: 'needs_review' } }
      expect(evaluateCondition(condition, stepResults)).toBe(true)
    })
  })
})
