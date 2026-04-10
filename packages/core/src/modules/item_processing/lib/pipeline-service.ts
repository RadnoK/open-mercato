import type { EntityManager } from '@mikro-orm/postgresql'
import { ProcessingPipeline } from '../data/entities'
import type { TenantScope, PipelineStepDefinition } from './types'
import type { CreatePipelineInput, UpdatePipelineInput } from '../data/validators'

export function createPipelineService(em: EntityManager) {
  function validateSteps(steps: PipelineStepDefinition[]): string | null {
    const keys = new Set<string>()
    for (const step of steps) {
      if (keys.has(step.stepKey)) {
        return `Duplicate stepKey: "${step.stepKey}"`
      }
      keys.add(step.stepKey)

      if (step.type === 'automated' && !step.providerKey) {
        return `Step "${step.stepKey}": providerKey is required for automated steps`
      }

      if (step.type === 'agent_review' && !step.agentConfig) {
        return `Step "${step.stepKey}": agentConfig is required for agent_review steps`
      }

      if (step.agentConfig) {
        if (step.agentConfig.escalateToHumanBelow > step.agentConfig.autoApproveThreshold) {
          return `Step "${step.stepKey}": escalateToHumanBelow must be <= autoApproveThreshold`
        }
      }
    }
    return null
  }

  async function createPipeline(input: CreatePipelineInput, scope: TenantScope): Promise<ProcessingPipeline> {
    const stepError = validateSteps(input.steps as PipelineStepDefinition[])
    if (stepError) throw new Error(stepError)

    const existing = await em.findOne(ProcessingPipeline, {
      pipelineKey: input.pipelineKey,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    })
    if (existing) {
      throw Object.assign(new Error(`Pipeline with key "${input.pipelineKey}" already exists`), { status: 409 })
    }

    const pipeline = em.create(ProcessingPipeline, {
      pipelineKey: input.pipelineKey,
      name: input.name,
      description: input.description ?? null,
      steps: input.steps as PipelineStepDefinition[],
      webhookUrl: input.webhookUrl ?? null,
      isActive: true,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
    })
    em.persist(pipeline)
    await em.flush()

    return pipeline
  }

  async function getPipeline(id: string, scope: TenantScope): Promise<ProcessingPipeline | null> {
    return em.findOne(ProcessingPipeline, {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    })
  }

  async function getPipelineByKey(key: string, scope: TenantScope): Promise<ProcessingPipeline | null> {
    return em.findOne(ProcessingPipeline, {
      pipelineKey: key,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    })
  }

  async function listPipelines(scope: TenantScope): Promise<ProcessingPipeline[]> {
    return em.find(ProcessingPipeline, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      isActive: true,
      deletedAt: null,
    }, {
      orderBy: { name: 'ASC' },
    })
  }

  async function updatePipeline(id: string, input: UpdatePipelineInput, scope: TenantScope): Promise<ProcessingPipeline | null> {
    const pipeline = await getPipeline(id, scope)
    if (!pipeline) return null

    if (input.steps) {
      const stepError = validateSteps(input.steps as PipelineStepDefinition[])
      if (stepError) throw new Error(stepError)
    }

    if (input.name !== undefined) pipeline.name = input.name
    if (input.description !== undefined) pipeline.description = input.description
    if (input.steps !== undefined) pipeline.steps = input.steps as PipelineStepDefinition[]
    if (input.webhookUrl !== undefined) pipeline.webhookUrl = input.webhookUrl
    if (input.isActive !== undefined) pipeline.isActive = input.isActive

    await em.flush()
    return pipeline
  }

  return {
    createPipeline,
    getPipeline,
    getPipelineByKey,
    listPipelines,
    updatePipeline,
    validateSteps,
  }
}

export type PipelineService = ReturnType<typeof createPipelineService>
