import { createQueue, type Queue } from '@open-mercato/queue'
import { getRedisUrl } from '@open-mercato/shared/lib/redis/connection'

const QUEUE_NAME = 'item-processing-run'

let queue: Queue<Record<string, unknown>> | null = null

export function getItemProcessingQueue(): Queue<Record<string, unknown>> {
  if (queue) return queue

  queue = process.env.QUEUE_STRATEGY === 'async'
    ? createQueue<Record<string, unknown>>(QUEUE_NAME, 'async', {
      connection: { url: getRedisUrl('QUEUE') },
    })
    : createQueue<Record<string, unknown>>(QUEUE_NAME, 'local')

  return queue
}
