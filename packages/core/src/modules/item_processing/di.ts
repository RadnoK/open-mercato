import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { ProcessingJob, ProcessingItem, ProcessingPipeline } from './data/entities'

export function register(container: AppContainer) {
  container.register({
    ProcessingJob: asValue(ProcessingJob),
    ProcessingItem: asValue(ProcessingItem),
    ProcessingPipeline: asValue(ProcessingPipeline),
  })
}
