import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  // Job CRUD
  { id: 'item_processing.job.created', label: 'Job Created', entity: 'job', category: 'crud' },
  { id: 'item_processing.job.updated', label: 'Job Updated', entity: 'job', category: 'crud' },
  { id: 'item_processing.job.deleted', label: 'Job Deleted', entity: 'job', category: 'crud' },

  // Job lifecycle
  { id: 'item_processing.job.started', label: 'Job Started', entity: 'job', category: 'lifecycle' },
  { id: 'item_processing.job.step_completed', label: 'Step Completed', entity: 'job', category: 'lifecycle', clientBroadcast: true },
  { id: 'item_processing.job.paused_for_review', label: 'Paused for Review', entity: 'job', category: 'lifecycle', clientBroadcast: true },
  { id: 'item_processing.job.completed', label: 'Job Completed', entity: 'job', category: 'lifecycle', clientBroadcast: true },
  { id: 'item_processing.job.failed', label: 'Job Failed', entity: 'job', category: 'lifecycle', clientBroadcast: true },

  // Item lifecycle
  { id: 'item_processing.item.processed', label: 'Item Processed', entity: 'item', category: 'lifecycle' },
  { id: 'item_processing.item.review_submitted', label: 'Review Submitted', entity: 'item', category: 'lifecycle' },

  // Agent review
  { id: 'item_processing.item.agent_decided', label: 'Agent Made Decision', entity: 'item', category: 'lifecycle' },
  { id: 'item_processing.item.agent_escalated', label: 'Agent Escalated to Human', entity: 'item', category: 'lifecycle', clientBroadcast: true },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'item_processing',
  events,
})

export const emitItemProcessingEvent = eventsConfig.emit

export type ItemProcessingEventId = typeof events[number]['id']

export default eventsConfig
