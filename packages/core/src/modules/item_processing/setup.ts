import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['item_processing.*'],
    employee: ['item_processing.view', 'item_processing.run', 'item_processing.review'],
  },

  // seedDefaults will be added in WS-6 (pipeline templates)
}

export default setup
