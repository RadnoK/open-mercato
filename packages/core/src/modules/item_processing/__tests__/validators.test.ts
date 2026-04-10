import {
  stepConditionSchema,
  agentReviewConfigSchema,
  pipelineStepSchema,
  createPipelineSchema,
  createJobSchema,
  bulkSubmitReviewSchema,
} from '../data/validators'

describe('stepConditionSchema', () => {
  it('accepts valid condition', () => {
    expect(stepConditionSchema.safeParse({ field: 'confidence', op: 'gt', value: 70 }).success).toBe(true)
  })

  it('rejects empty field', () => {
    expect(stepConditionSchema.safeParse({ field: '', op: 'gt', value: 70 }).success).toBe(false)
  })

  it('rejects invalid operator', () => {
    expect(stepConditionSchema.safeParse({ field: 'x', op: 'invalid', value: 1 }).success).toBe(false)
  })

  it('accepts all valid operators', () => {
    for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains']) {
      expect(stepConditionSchema.safeParse({ field: 'x', op, value: 1 }).success).toBe(true)
    }
  })
})

describe('agentReviewConfigSchema', () => {
  const validConfig = {
    prompt: 'Review this item and decide',
    autoApproveThreshold: 85,
    escalateToHumanBelow: 50,
    includeStepResults: true,
    includeSuggestions: true,
    strategy: 'pick_if_confident',
  }

  it('accepts valid config', () => {
    expect(agentReviewConfigSchema.safeParse(validConfig).success).toBe(true)
  })

  it('rejects prompt too short', () => {
    expect(agentReviewConfigSchema.safeParse({ ...validConfig, prompt: 'short' }).success).toBe(false)
  })

  it('rejects threshold out of range', () => {
    expect(agentReviewConfigSchema.safeParse({ ...validConfig, autoApproveThreshold: 150 }).success).toBe(false)
  })

  it('rejects escalate > autoApprove (refine)', () => {
    const result = agentReviewConfigSchema.safeParse({ ...validConfig, escalateToHumanBelow: 90, autoApproveThreshold: 50 })
    expect(result.success).toBe(false)
  })

  it('accepts all valid strategies', () => {
    for (const strategy of ['pick_best', 'pick_if_confident', 'always_escalate', 'custom']) {
      expect(agentReviewConfigSchema.safeParse({ ...validConfig, strategy }).success).toBe(true)
    }
  })
})

describe('pipelineStepSchema', () => {
  it('accepts valid automated step', () => {
    const result = pipelineStepSchema.safeParse({
      stepKey: 'translate',
      label: 'Translate',
      type: 'automated',
      providerKey: 'ai_translate',
    })
    expect(result.success).toBe(true)
  })

  it('accepts valid review step', () => {
    const result = pipelineStepSchema.safeParse({
      stepKey: 'review',
      label: 'Review',
      type: 'review',
    })
    expect(result.success).toBe(true)
  })

  it('rejects automated step without providerKey', () => {
    const result = pipelineStepSchema.safeParse({
      stepKey: 'classify',
      label: 'Classify',
      type: 'automated',
    })
    expect(result.success).toBe(false)
  })

  it('rejects agent_review step without agentConfig', () => {
    const result = pipelineStepSchema.safeParse({
      stepKey: 'agent',
      label: 'Agent',
      type: 'agent_review',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid stepKey format', () => {
    expect(pipelineStepSchema.safeParse({
      stepKey: 'Invalid-Key',
      label: 'Test',
      type: 'review',
    }).success).toBe(false)
  })

  it('accepts stepKey with underscores', () => {
    expect(pipelineStepSchema.safeParse({
      stepKey: 'classify_hs_codes',
      label: 'Classify',
      type: 'automated',
      providerKey: 'test',
    }).success).toBe(true)
  })
})

describe('createPipelineSchema', () => {
  it('accepts valid pipeline', () => {
    const result = createPipelineSchema.safeParse({
      pipelineKey: 'test_pipeline',
      name: 'Test Pipeline',
      steps: [{ stepKey: 'review', label: 'Review', type: 'review' }],
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty steps', () => {
    const result = createPipelineSchema.safeParse({
      pipelineKey: 'test',
      name: 'Test',
      steps: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid pipelineKey', () => {
    const result = createPipelineSchema.safeParse({
      pipelineKey: 'Invalid Key!',
      name: 'Test',
      steps: [{ stepKey: 'review', label: 'R', type: 'review' }],
    })
    expect(result.success).toBe(false)
  })
})

describe('createJobSchema', () => {
  it('accepts valid job', () => {
    const result = createJobSchema.safeParse({
      pipelineKey: 'test',
      items: [{ name: 'item1' }],
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty items', () => {
    const result = createJobSchema.safeParse({
      pipelineKey: 'test',
      items: [],
    })
    expect(result.success).toBe(false)
  })

  it('accepts autoStart flag', () => {
    const result = createJobSchema.safeParse({
      pipelineKey: 'test',
      items: [{ a: 1 }],
      autoStart: true,
    })
    expect(result.success).toBe(true)
  })
})

describe('bulkSubmitReviewSchema', () => {
  it('accepts valid selections', () => {
    const result = bulkSubmitReviewSchema.safeParse({
      selections: [{ itemId: '550e8400-e29b-41d4-a716-446655440000', selectedValue: { hsCode: '8471' } }],
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty selections', () => {
    const result = bulkSubmitReviewSchema.safeParse({ selections: [] })
    expect(result.success).toBe(false)
  })

  it('defaults resume to true', () => {
    const result = bulkSubmitReviewSchema.safeParse({
      selections: [{ itemId: '550e8400-e29b-41d4-a716-446655440000', selectedValue: { a: 1 } }],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.resume).toBe(true)
    }
  })
})
