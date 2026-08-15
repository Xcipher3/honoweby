import type { AppOpenAPI } from './types.js'

import { Scalar } from '@scalar/hono-api-reference'

export default function configureOpenAPI(app: AppOpenAPI) {
  app.doc('/doc', {
    openapi: '3.0.0',
    info: {
      version: '1.0.0',
      title: 'Webhook API',
    },
  })

  app.get(
    '/reference',
    Scalar({
      url: '/doc',
      theme: 'kepler',
      layout: 'classic',
      defaultHttpClient: {
        targetKey: 'js',
        clientKey: 'fetch',
      },
    }),
  )
}
