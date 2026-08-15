import { createRoute, z } from '@hono/zod-openapi'
import * as HttpStatusCodes from 'stoker/http-status-codes'
import { jsonContent } from 'stoker/openapi/helpers'
import { createMessageObjectSchema } from 'stoker/openapi/schemas'

/**
 * Canonical payment webhook payload.
 * NOTE: currency is locked to KES per product requirement.
 * The body is intentionally NOT declared on this OpenAPI route's `request.body`
 * so that zod-openapi does not eagerly parse/validate it before we have
 * verified the HMAC signature on the RAW bytes (signature-first security model).
 */
export const paymentEventSchema = z.object({
  event_id: z.string().min(1),
  type: z.string().min(1),
  timestamp: z.string().datetime(),
  data: z.object({
    transaction_id: z.string().min(1),
    amount_cents: z.number().int().nonnegative(),
    currency: z.enum(['KES']),
    customer_email: z.string().email(),
    status: z.string().min(1),
  }),
})

export type PaymentEvent = z.infer<typeof paymentEventSchema>

/** Response envelope for 400 Bad Request (malformed JSON or invalid payload). */
export const badRequestSchema = z.object({
  message: z.string(),
  issues: z
    .array(
      z.object({
        code: z.string(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
        message: z.string().optional(),
      }),
    )
    .optional(),
})

const tags = ['Webhooks']

export const paymentWebhook = createRoute({
  path: '/webhooks/payment',
  method: 'post',
  tags,
  summary: 'Ingest a third-party payment gateway webhook event',
  description:
    'Verifies the X-Webhook-Signature (HMAC-SHA256 over `t.<raw_body>`), '
    + 'validates the payload, and idempotently appends the event to the ledger.',
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      createMessageObjectSchema('Acknowledged'),
      'Event acknowledged (processed or already-ledgered duplicate)',
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      badRequestSchema,
      'Malformed JSON or invalid payload',
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Missing or invalid signature',
    ),
    [HttpStatusCodes.SERVICE_UNAVAILABLE]: jsonContent(
      createMessageObjectSchema('Temporarily Unavailable'),
      'SLA timeout (5s cap exceeded); safe to retry (idempotent).',
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema('Internal Server Error'),
      'Internal Server Error',
    ),
  },
})

export type PaymentWebhookRoute = typeof paymentWebhook
