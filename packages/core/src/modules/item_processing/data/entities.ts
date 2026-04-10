import { Entity, Index, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core'
import type { PipelineStepDefinition, JobStatus, ItemStatus } from '../lib/types'

// ─── ProcessingPipeline ─────────────────────────────────────────────────────

@Entity({ tableName: 'processing_pipelines' })
@Index({ properties: ['tenantId', 'organizationId'] })
@Index({ properties: ['tenantId', 'pipelineKey'], options: { unique: true } })
export class ProcessingPipeline {
  [OptionalProps]?: 'isActive' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'createdBy' | 'description' | 'webhookUrl'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'pipeline_key', type: 'text' })
  pipelineKey!: string

  @Property({ name: 'name', type: 'text' })
  name!: string

  @Property({ name: 'description', type: 'text', nullable: true })
  description?: string | null

  @Property({ name: 'steps', type: 'jsonb' })
  steps!: PipelineStepDefinition[]

  @Property({ name: 'webhook_url', type: 'text', nullable: true })
  webhookUrl?: string | null

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

// ─── ProcessingJob ──────────────────────────────────────────────────────────

@Entity({ tableName: 'processing_jobs' })
@Index({ properties: ['tenantId', 'organizationId'] })
@Index({ properties: ['status'] })
@Index({ properties: ['pipelineId'] })
export class ProcessingJob {
  [OptionalProps]?: 'status' | 'currentStep' | 'totalItems' | 'processedItems' | 'failedItems' | 'skippedItems' | 'progressJobId' | 'sourceType' | 'sourceId' | 'config' | 'resultSummary' | 'startedAt' | 'completedAt' | 'createdBy' | 'name' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'pipeline_id', type: 'uuid' })
  pipelineId!: string

  @Property({ name: 'name', type: 'text', nullable: true })
  name?: string | null

  @Property({ name: 'status', type: 'text' })
  status: JobStatus = 'pending'

  @Property({ name: 'current_step', type: 'text', nullable: true })
  currentStep?: string | null

  @Property({ name: 'total_items', type: 'int', default: 0 })
  totalItems: number = 0

  @Property({ name: 'processed_items', type: 'int', default: 0 })
  processedItems: number = 0

  @Property({ name: 'failed_items', type: 'int', default: 0 })
  failedItems: number = 0

  @Property({ name: 'skipped_items', type: 'int', default: 0 })
  skippedItems: number = 0

  @Property({ name: 'progress_job_id', type: 'uuid', nullable: true })
  progressJobId?: string | null

  @Property({ name: 'source_type', type: 'text', nullable: true })
  sourceType?: string | null

  @Property({ name: 'source_id', type: 'uuid', nullable: true })
  sourceId?: string | null

  @Property({ name: 'config', type: 'jsonb', nullable: true })
  config?: PipelineStepDefinition[] | null

  @Property({ name: 'result_summary', type: 'jsonb', nullable: true })
  resultSummary?: Record<string, unknown> | null

  @Property({ name: 'started_at', type: Date, nullable: true })
  startedAt?: Date | null

  @Property({ name: 'completed_at', type: Date, nullable: true })
  completedAt?: Date | null

  @Property({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

// ─── ProcessingItem ─────────────────────────────────────────────────────────

@Entity({ tableName: 'processing_items' })
@Index({ properties: ['jobId'] })
@Index({ properties: ['jobId', 'status'] })
export class ProcessingItem {
  [OptionalProps]?: 'status' | 'currentStep' | 'outputData' | 'stepResults' | 'selectedValues' | 'errorMessage' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'job_id', type: 'uuid' })
  jobId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'item_index', type: 'int' })
  itemIndex!: number

  @Property({ name: 'status', type: 'text' })
  status: ItemStatus = 'pending'

  @Property({ name: 'current_step', type: 'text', nullable: true })
  currentStep?: string | null

  @Property({ name: 'input_data', type: 'jsonb' })
  inputData!: Record<string, unknown>

  @Property({ name: 'output_data', type: 'jsonb', nullable: true })
  outputData?: Record<string, unknown> | null

  @Property({ name: 'step_results', type: 'jsonb', nullable: true })
  stepResults?: Record<string, unknown> | null

  @Property({ name: 'selected_values', type: 'jsonb', nullable: true })
  selectedValues?: Record<string, unknown> | null

  @Property({ name: 'error_message', type: 'text', nullable: true })
  errorMessage?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
