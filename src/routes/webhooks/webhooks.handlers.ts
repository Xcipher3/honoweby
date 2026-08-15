import type { PaymentWebhookRoute } from './webhooks.routes.js'
import type { AppRouteHandler } from '@/lib/types'

import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'

import * as HttpStatusCodes from 'stoker/http-status-codes'
import db from '@/db'
import { ledgerEntries, processedEvents } from '@/db/schema'

import env from '@/env'
import { paymentEventSchema } from './webhooks.routes.js'

const PAYLOAD_TIMEOUT_MS = 5000

function parseSignature(header: string | undefined): { t: string, v1: string } | null {
  if (!header) {
    return null
  }
  const map = new Map<string, string>()
  for (const part of header.split(',')) {
    const eqIdx = part.indexOf('=')
    if (eqIdx === -1) {
      return null
    }
    map.set(part.slice(0, eqIdx).trim(), part.slice(eqIdx + 1).trim())
  }
  const t = map.get('t')
  const v1 = map.get('v1')
  if (!t || !v1) {
    return null
  }
  return { t, v1 }
}

function maskEmail(email: string): string {
  const atIdx = email.indexOf('@')
  if (atIdx <= 1) {
    return '[redacted]'
  }
  const local = email.slice(0, atIdx)
  const domain = email.slice(atIdx + 1)
  if (local.length <= 1) {
    return `${local}***@${domain}`
  }
  return `${local[0]}***${local[local.length - 1]}@${domain}`
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`DB_TIMEOUT:${ms}`)), ms)
  })
  return Promise.race([
    promise,
    timeout,
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  }) as Promise<T>
}

export const ingest: AppRouteHandler<PaymentWebhookRoute> = async (c) => {
  const logger = c.get('logger')
  const startedAt = Date.now()
  const logCtx: Record<string, unknown> = {}

  // Capture the RAW body exactly once. Hono caches it, so downstream
  // consumers (here: the manual JSON.parse + Zod) re-read from cache.
  const rawBody = await c.req.text()

  // --- Part A: signature verification (before any payload processing) ---
  const signature = parseSignature(c.req.header('x-webhook-signature'))
  if (!signature) {
    logger.warn(logCtx, 'webhook_rejected_missing_signature')
    return c.json(
      { message: 'Unauthorized: missing or malformed signature' },
      HttpStatusCodes.UNAUTHORIZED,
    )
  }

  const { t, v1 } = signature
  const signedPayload = `${t}.${rawBody}`
  const expected = createHmac('sha256', env.WEBHOOK_SECRET)
    .update(signedPayload)
    .digest('hex')

  const signatureValid = expected.length === v1.length
    && timingSafeEqual(Buffer.from(expected), Buffer.from(v1))

  if (!signatureValid) {
    logger.warn({ ...logCtx, event_t: t }, 'webhook_rejected_bad_signature')
    return c.json(
      { message: 'Unauthorized: invalid signature' },
      HttpStatusCodes.UNAUTHORIZED,
    )
  }

  // Replay protection: reject timestamps outside the tolerance window.
  const tsNum = Number(t)
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > env.WEBHOOK_TOLERANCE_SECONDS) {
    logger.warn({ ...logCtx, event_t: t }, 'webhook_rejected_stale_timestamp')
    return c.json(
      { message: 'Unauthorized: stale timestamp' },
      HttpStatusCodes.UNAUTHORIZED,
    )
  }

  // --- Part B: payload validation (signature already verified) ---
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  }
  catch {
    logger.warn(logCtx, 'webhook_rejected_malformed_json')
    return c.json(
      { message: 'Bad Request: malformed JSON body' },
      HttpStatusCodes.BAD_REQUEST,
    )
  }

  const result = paymentEventSchema.safeParse(parsed)
  if (!result.success) {
    logger.warn(
      { ...logCtx, issues: result.error.issues },
      'webhook_rejected_invalid_payload',
    )
    return c.json(
      { message: 'Bad Request: invalid payload', issues: result.error.issues },
      HttpStatusCodes.BAD_REQUEST,
    )
  }

  const payload = result.data
  const customerEmailMasked = maskEmail(payload.data.customer_email)

  // --- Part C: atomic idempotent append ---
  // Single transaction: the dedup gate (processed_events) and the ledger
  // append (ledger_entries) commit together, so a failure mid-way rolls
  // back BOTH and the event is safe to retry. `ON CONFLICT DO NOTHING`
  // guarantees exactly-once even under concurrent duplicate deliveries:
  // the loser inserts nothing, returns 200, and triggers no side effects.
  try {
    const outcome = await withTimeout(
      db.transaction(async (tx) => {
        const inserted = await tx
          .insert(processedEvents)
          .values({
            eventId: payload.event_id,
            transactionId: payload.data.transaction_id,
          })
          .onConflictDoNothing()
          .returning({ eventId: processedEvents.eventId })

        if (inserted.length === 0) {
          return 'duplicate' as const
        }

        await tx.insert(ledgerEntries).values({
          eventId: payload.event_id,
          transactionId: payload.data.transaction_id,
          amountCents: payload.data.amount_cents,
          currency: payload.data.currency,
          customerEmail: customerEmailMasked,
          status: payload.data.status,
          eventType: payload.type,
          occurredAt: payload.timestamp,
        })

        return 'processed' as const
      }),
      PAYLOAD_TIMEOUT_MS,
    )

    const latencyMs = Date.now() - startedAt
    logger.info(
      {
        ...logCtx,
        event_id: payload.event_id,
        event_type: payload.type,
        amount_cents: payload.data.amount_cents,
        currency: payload.data.currency,
        customer_email_masked: customerEmailMasked,
        outcome,
        latency_ms: latencyMs,
      },
      'webhook',
    )

    return c.json(
      { message: 'Acknowledged' },
      HttpStatusCodes.OK,
    )
  }
  catch (err) {
    if (err instanceof Error && err.message.startsWith('DB_TIMEOUT')) {
      logger.warn({ ...logCtx, outcome: 'timeout' }, 'webhook_sla_timeout')
      // 503 is retryable; the transaction rolled back, so no partial writes.
      return c.json(
        { message: 'Temporarily Unavailable: processing exceeded SLA' },
        HttpStatusCodes.SERVICE_UNAVAILABLE,
      )
    }
    logger.error({ ...logCtx, err: String(err) }, 'webhook_internal_error')
    return c.json(
      { message: 'Internal Server Error' },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    )
  }
}
