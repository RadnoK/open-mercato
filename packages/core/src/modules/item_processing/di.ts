import { asFunction, asValue } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { ProgressService } from '../progress/lib/progressService'
import { ProcessingJob, ProcessingItem, ProcessingPipeline } from './data/entities'
import { createJobService } from './lib/job-service'
import { createPipelineService } from './lib/pipeline-service'
import { createProcessingEngine } from './lib/processing-engine'
import { createAgentReviewer } from './lib/agent-reviewer'
import { createPipelineDesigner } from './lib/pipeline-designer'
import { createAnomalyDetector } from './lib/anomaly-detector'

type Cradle = {
  em: EntityManager
  progressService: ProgressService
}

export function register(container: AppContainer) {
  container.register({
    // Entity classes
    ProcessingJob: asValue(ProcessingJob),
    ProcessingItem: asValue(ProcessingItem),
    ProcessingPipeline: asValue(ProcessingPipeline),

    // Core services
    itemProcessingJobService: asFunction(({ em }: Cradle) =>
      createJobService(em),
    ).scoped().proxy(),

    itemProcessingPipelineService: asFunction(({ em }: Cradle) =>
      createPipelineService(em),
    ).scoped().proxy(),

    // AI services
    itemProcessingAgentReviewer: asFunction(() =>
      createAgentReviewer(),
    ).scoped().proxy(),

    itemProcessingPipelineDesigner: asFunction(() =>
      createPipelineDesigner(),
    ).scoped().proxy(),

    itemProcessingAnomalyDetector: asFunction(() =>
      createAnomalyDetector(),
    ).scoped().proxy(),

    // Engine (depends on job service + agent reviewer)
    itemProcessingEngine: asFunction(({ em, progressService, itemProcessingJobService, itemProcessingAgentReviewer }: Cradle & {
      itemProcessingJobService: ReturnType<typeof createJobService>
      itemProcessingAgentReviewer: ReturnType<typeof createAgentReviewer>
    }) =>
      createProcessingEngine({
        em,
        jobService: itemProcessingJobService,
        progressService,
        agentReviewer: itemProcessingAgentReviewer,
      }),
    ).scoped().proxy(),
  })
}
