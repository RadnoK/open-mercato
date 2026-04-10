import { z } from 'zod'

const uuid = () => z.string().uuid()

// ─── Step Condition ─────────────────────────────────────────────────────────

export const stepConditionSchema = z.object({
  field: z.string().min(1),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains']),
  value: z.unknown(),
})

// ─── Agent Review Config ────────────────────────────────────────────────────

export const agentReviewConfigSchema = z.object({
  prompt: z.string().min(10).max(5000),
  autoApproveThreshold: z.number().min(0).max(100),
  escalateToHumanBelow: z.number().min(0).max(100),
  includeStepResults: z.boolean().default(true),
  includeSuggestions: z.boolean().default(true),
  strategy: z.enum(['pick_best', 'pick_if_confident', 'always_escalate', 'custom']),
  maxAutoApprovals: z.number().int().min(1).max(100000).optional(),
  outputSchema: z.record(z.string(), z.string()).optional(),
}).refine(
  (data) => data.escalateToHumanBelow <= data.autoApproveThreshold,
  { message: 'escalateToHumanBelow must be <= autoApproveThreshold' },
)

// ─── Pipeline Step ──────────────────────────────────────────────────────────

const stepKeyRegex = /^[a-z][a-z0-9_]*$/

export const pipelineStepSchema = z.object({
  stepKey: z.string().min(1).max(100).regex(stepKeyRegex, 'stepKey must be lowercase alphanumeric with underscores'),
  label: z.string().min(1).max(200),
  type: z.enum(['automated', 'review', 'agent_review']),
  providerKey: z.string().min(1).max(100).optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
  inputMapping: z.record(z.string(), z.string()).optional(),
  outputMapping: z.record(z.string(), z.string()).optional(),
  optional: z.boolean().optional(),
  retryPolicy: z.object({
    maxRetries: z.number().int().min(0).max(10),
    backoffMs: z.number().int().min(100).max(60000),
  }).optional(),
  condition: z.union([stepConditionSchema, z.array(stepConditionSchema)]).optional(),
  agentConfig: agentReviewConfigSchema.optional(),
}).refine(
  (data) => {
    if (data.type === 'automated' && !data.providerKey) return false
    return true
  },
  { message: 'providerKey is required for automated steps' },
).refine(
  (data) => {
    if (data.type === 'agent_review' && !data.agentConfig) return false
    return true
  },
  { message: 'agentConfig is required for agent_review steps' },
)

// ─── Pipeline CRUD ──────────────────────────────────────────────────────────

export const createPipelineSchema = z.object({
  pipelineKey: z.string().min(1).max(100).regex(stepKeyRegex, 'pipelineKey must be lowercase alphanumeric with underscores'),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  steps: z.array(pipelineStepSchema).min(1).max(50),
  webhookUrl: z.string().url().optional(),
})

export const updatePipelineSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  steps: z.array(pipelineStepSchema).min(1).max(50).optional(),
  webhookUrl: z.string().url().nullable().optional(),
  isActive: z.boolean().optional(),
})

// ─── Job CRUD ───────────────────────────────────────────────────────────────

export const createJobSchema = z.object({
  pipelineKey: z.string().min(1),
  name: z.string().max(200).optional(),
  items: z.array(z.record(z.string(), z.unknown())).min(1).max(10000),
  sourceType: z.enum(['manual', 'document_parser', 'csv', 'api']).optional(),
  sourceId: uuid().optional(),
  autoStart: z.boolean().optional(),
})

// ─── Review ─────────────────────────────────────────────────────────────────

export const submitItemReviewSchema = z.object({
  selectedValue: z.record(z.string(), z.unknown()),
})

export const bulkSubmitReviewSchema = z.object({
  selections: z.array(z.object({
    itemId: uuid(),
    selectedValue: z.record(z.string(), z.unknown()),
  })).min(1),
  resume: z.boolean().optional().default(true),
})

// ─── Derived Types ──────────────────────────────────────────────────────────

export type StepConditionInput = z.infer<typeof stepConditionSchema>
export type AgentReviewConfigInput = z.infer<typeof agentReviewConfigSchema>
export type PipelineStepInput = z.infer<typeof pipelineStepSchema>
export type CreatePipelineInput = z.infer<typeof createPipelineSchema>
export type UpdatePipelineInput = z.infer<typeof updatePipelineSchema>
export type CreateJobInput = z.infer<typeof createJobSchema>
export type SubmitItemReviewInput = z.infer<typeof submitItemReviewSchema>
export type BulkSubmitReviewInput = z.infer<typeof bulkSubmitReviewSchema>
