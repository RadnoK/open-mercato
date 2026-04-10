import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'item_processing',
  title: 'Item Processing',
  version: '0.1.0',
  description: 'Generic pipeline for batch item enrichment with pluggable providers, human-in-the-loop review, and AI agent review.',
  author: 'Open Mercato Team',
  license: 'Proprietary',
  ejectable: true,
}

export { features } from './acl'
