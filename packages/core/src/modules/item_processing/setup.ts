import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { ProcessingPipeline } from './data/entities'
import type { PipelineStepDefinition } from './lib/types'

const PIPELINE_TEMPLATES: Array<{
  pipelineKey: string
  name: string
  description: string
  steps: PipelineStepDefinition[]
}> = [
  {
    pipelineKey: 'customs_hs_classification',
    name: 'HS Code Classification (Customs)',
    description: 'Translate product descriptions, classify via external API, AI agent review with human escalation for ambiguous items',
    steps: [
      {
        stepKey: 'translate',
        label: 'Translate to Polish',
        type: 'automated',
        providerKey: 'ai_translate',
        providerConfig: { targetLang: 'pl', fields: ['description'] },
        outputMapping: { description_pl: 'description_pl' },
        optional: true,
      },
      {
        stepKey: 'classify_hs',
        label: 'HS Code Classification',
        type: 'automated',
        providerKey: 'isztar_hs_classification',
        inputMapping: { description: 'description_pl' },
      },
      {
        stepKey: 'agent_review',
        label: 'AI Agent Review',
        type: 'agent_review',
        agentConfig: {
          prompt: 'Review the HS code classification for this customs item. Consider the product description, the suggested codes, and their confidence scores. Select the most appropriate code. If the item is ambiguous or could fall into multiple categories, escalate to human review.',
          autoApproveThreshold: 85,
          escalateToHumanBelow: 50,
          includeStepResults: true,
          includeSuggestions: true,
          strategy: 'pick_if_confident',
          maxAutoApprovals: 100,
        },
      },
      {
        stepKey: 'human_review',
        label: 'Human Review (escalated only)',
        type: 'review',
        condition: { field: 'agent_review.finalDecision', op: 'eq', value: 'escalated' },
      },
    ],
  },
  {
    pipelineKey: 'product_data_validation',
    name: 'Product Data Quality Check',
    description: 'Validate product data against schema and review errors',
    steps: [
      {
        stepKey: 'validate',
        label: 'Validate Schema',
        type: 'automated',
        providerKey: 'schema_validate',
        providerConfig: {
          schema: {
            name: { type: 'string', required: true, minLength: 1 },
            quantity: { type: 'number', required: true, min: 0 },
          },
        },
      },
      {
        stepKey: 'review_errors',
        label: 'Review Validation Errors',
        type: 'review',
      },
    ],
  },
  {
    pipelineKey: 'generic_ai_enrichment',
    name: 'Generic AI Enrichment',
    description: 'Process items with AI transform and review results',
    steps: [
      {
        stepKey: 'transform',
        label: 'AI Transform',
        type: 'automated',
        providerKey: 'ai_transform',
        providerConfig: {
          prompt: 'Analyze this item and extract key attributes: {{description}}',
          outputSchema: { category: 'string', tags: 'array', summary: 'string' },
        },
      },
      {
        stepKey: 'review',
        label: 'Review Results',
        type: 'review',
      },
    ],
  },
]

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['item_processing.*'],
    employee: ['item_processing.view', 'item_processing.run', 'item_processing.review'],
  },

  async seedDefaults({ em, tenantId, organizationId }) {
    for (const template of PIPELINE_TEMPLATES) {
      const existing = await em.findOne(ProcessingPipeline, {
        pipelineKey: template.pipelineKey,
        tenantId,
        organizationId,
        deletedAt: null,
      })

      if (!existing) {
        const pipeline = em.create(ProcessingPipeline, {
          pipelineKey: template.pipelineKey,
          name: template.name,
          description: template.description,
          steps: template.steps,
          isActive: true,
          organizationId,
          tenantId,
        })
        em.persist(pipeline)
      }
    }
    await em.flush()
  },
}

export default setup
