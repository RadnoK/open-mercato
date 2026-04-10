import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { registerStepProvider } from '@open-mercato/core/modules/item_processing/lib/provider-registry'
import { isztarHsProvider } from './lib/isztar-hs.provider'

export function register(_container: AppContainer) {
  registerStepProvider(isztarHsProvider)
}
