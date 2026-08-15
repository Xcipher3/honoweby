import configureOpenAPI from '@/lib/configure-open-api'
import createApp from '@/lib/create-app'
import indexRoute from '@/routes/index.route'
import webhooks from '@/routes/webhooks/webhooks.index'

const app = createApp()

configureOpenAPI(app)

const routes = [
  indexRoute,
  webhooks,
] as const

routes.forEach((route) => {
  app.route('/', route)
})

export type AppType = typeof routes[number]

export default app
