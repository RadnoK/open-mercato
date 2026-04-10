import { createPipelineService } from '../lib/pipeline-service'

describe('pipeline-service validation', () => {
  // We test the validateSteps function directly since it's pure logic
  // (no DB needed)

  function getService() {
    // Create with a mock em — we only test validateSteps which doesn't use em
    const mockEm = {} as any
    const service = createPipelineService(mockEm)
    return service
  }

  it('rejects duplicate stepKeys', () => {
    const service = getService()
    const error = service.validateSteps([
      { stepKey: 'step1', label: 'S1', type: 'review' },
      { stepKey: 'step1', label: 'S2', type: 'review' },
    ])
    expect(error).toContain('Duplicate stepKey')
  })

  it('rejects automated step without providerKey', () => {
    const service = getService()
    const error = service.validateSteps([
      { stepKey: 'classify', label: 'Classify', type: 'automated' },
    ])
    expect(error).toContain('providerKey')
  })

  it('rejects agent_review step without agentConfig', () => {
    const service = getService()
    const error = service.validateSteps([
      { stepKey: 'agent', label: 'Agent', type: 'agent_review' },
    ])
    expect(error).toContain('agentConfig')
  })

  it('accepts valid review step', () => {
    const service = getService()
    const error = service.validateSteps([
      { stepKey: 'review', label: 'Review', type: 'review' },
    ])
    expect(error).toBeNull()
  })

  it('accepts valid automated step with providerKey', () => {
    const service = getService()
    const error = service.validateSteps([
      { stepKey: 'translate', label: 'Translate', type: 'automated', providerKey: 'ai_translate' },
    ])
    expect(error).toBeNull()
  })

  it('accepts valid agent_review step with agentConfig', () => {
    const service = getService()
    const error = service.validateSteps([
      {
        stepKey: 'agent',
        label: 'Agent',
        type: 'agent_review',
        agentConfig: {
          prompt: 'Review this item carefully',
          autoApproveThreshold: 85,
          escalateToHumanBelow: 50,
          includeStepResults: true,
          includeSuggestions: true,
          strategy: 'pick_if_confident' as const,
        },
      },
    ])
    expect(error).toBeNull()
  })

  it('rejects agentConfig where escalate > autoApprove', () => {
    const service = getService()
    const error = service.validateSteps([
      {
        stepKey: 'agent',
        label: 'Agent',
        type: 'agent_review',
        agentConfig: {
          prompt: 'Review this item carefully',
          autoApproveThreshold: 50,
          escalateToHumanBelow: 90,
          includeStepResults: true,
          includeSuggestions: true,
          strategy: 'pick_if_confident' as const,
        },
      },
    ])
    expect(error).toContain('escalateToHumanBelow')
  })

  it('accepts multi-step pipeline', () => {
    const service = getService()
    const error = service.validateSteps([
      { stepKey: 'translate', label: 'Translate', type: 'automated', providerKey: 'ai_translate' },
      { stepKey: 'classify', label: 'Classify', type: 'automated', providerKey: 'isztar_hs' },
      { stepKey: 'review', label: 'Review', type: 'review' },
    ])
    expect(error).toBeNull()
  })
})
