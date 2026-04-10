import { createCrudOpenApiFactory } from '@open-mercato/shared/lib/openapi/crud'

export const buildItemProcessingOpenApi = createCrudOpenApiFactory({
  defaultTag: 'ItemProcessing',
})
