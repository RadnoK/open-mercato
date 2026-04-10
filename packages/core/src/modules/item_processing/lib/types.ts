// ─── Tenant Scope ───────────────────────────────────────────────────────────

export interface TenantScope {
  organizationId: string
  tenantId: string
  userId?: string | null
}

// ─── Step Provider Contract ─────────────────────────────────────────────────

export interface StepProvider {
  readonly providerKey: string
  readonly displayName: string
  readonly description?: string
  readonly category: 'classification' | 'enrichment' | 'validation' | 'transformation'

  processItem(input: StepProviderInput): Promise<StepProviderResult>
  processBatch?(inputs: StepProviderInput[]): Promise<StepProviderResult[]>
  validateConfig?(config: Record<string, unknown>): Promise<StepProviderValidation>
}

export interface StepProviderInput {
  itemId: string
  itemIndex: number
  itemData: Record<string, unknown>
  stepConfig: Record<string, unknown>
  scope: TenantScope
}

export interface StepProviderResult {
  status: 'success' | 'error' | 'needs_review'
  data?: Record<string, unknown>
  suggestions?: StepSuggestion[]
  confidence?: number
  error?: string
}

export interface StepSuggestion {
  id: string
  label: string
  description?: string
  value: Record<string, unknown>
  confidence?: number
  metadata?: Record<string, unknown>
}

export interface StepProviderValidation {
  valid: boolean
  message?: string
}

// ─── Pipeline Step Definition ───────────────────────────────────────────────

export interface PipelineStepDefinition {
  stepKey: string
  label: string
  type: 'automated' | 'review' | 'agent_review'
  providerKey?: string
  providerConfig?: Record<string, unknown>
  inputMapping?: Record<string, string>
  outputMapping?: Record<string, string>
  optional?: boolean
  retryPolicy?: RetryPolicy
  condition?: StepCondition | StepCondition[]
  agentConfig?: AgentReviewConfig
}

export interface RetryPolicy {
  maxRetries: number
  backoffMs: number
}

// ─── Step Conditions ────────────────────────────────────────────────────────

export interface StepCondition {
  field: string
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'contains'
  value: unknown
}

// ─── Agent Review (Tier 3) ──────────────────────────────────────────────────

export type AgentReviewStrategy = 'pick_best' | 'pick_if_confident' | 'always_escalate' | 'custom'

export interface AgentReviewConfig {
  prompt: string
  autoApproveThreshold: number
  escalateToHumanBelow: number
  includeStepResults: boolean
  includeSuggestions: boolean
  strategy: AgentReviewStrategy
  maxAutoApprovals?: number
  outputSchema?: Record<string, string>
}

export type AgentFinalDecision = 'auto_approved' | 'escalated' | 'spot_check' | 'human_override'

export interface AgentReviewResult {
  decidedBy: 'agent' | 'human' | 'agent_escalated_to_human'
  agentConfidence: number
  agentReasoning: string
  agentSelectedSuggestionId: string | null
  agentNotes: string | null
  humanOverride: boolean
  humanSelectedSuggestionId: string | null
  finalDecision: AgentFinalDecision
  decidedAt: string
}

// ─── Job & Item Status ──────────────────────────────────────────────────────

export type JobStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export type ItemStatus = 'pending' | 'processing' | 'awaiting_review' | 'completed' | 'failed' | 'skipped'

export type SourceType = 'manual' | 'document_parser' | 'csv' | 'api'
