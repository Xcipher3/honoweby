import { createRouter } from '@/lib/create-app'

import * as handlers from './webhooks.handlers.js'
import * as routes from './webhooks.routes.js'

const router = createRouter().openapi(routes.paymentWebhook, handlers.ingest)

export default router
