import { createHmac } from 'node:crypto'
import { count, eq, sql } from 'drizzle-orm'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import db, { pool } from '@/db'
import { ledgerEntries, processedEvents } from '@/db/schema'
import env from '@/env'
import { createTestApp } from '@/lib/create-app'

import router from './webhooks.index.js'

if (env.NODE_ENV !== 'test') {
  throw new Error('NODE_ENV must be \'test\'')
}

const app = createTestApp(router)

const SECRET = env.WEBHOOK_SECRET

// Unique per-run prefix so tests never collide with existing data and
// never need to truncate the shared ledger (non-destructive by design).
const RUN_ID = `test_${Date.now()}_`

function sign(t: number, body: string, secret: string = SECRET): string {
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${sig}`
}

function bodyFor(
  opts: { eventId?: string, data?: Record<string, unknown> } = {},
  runId: string = RUN_ID,
): string {
  return JSON.stringify({
    event_id: opts.eventId ?? `${runId}valid`,
    type: 'payment.succeeded',
    timestamp: '2026-08-13T12:00:00Z',
    data: {
      transaction_id: `${runId}txn`,
      amount_cents: 14999,
      currency: 'KES',
      customer_email: 'user.email@example.com',
      status: 'completed',
      ...opts.data,
    },
  })
}

describe('webhooks.payment', () => {
  beforeAll(async () => {
    // The ledger tables must already exist (provisioned DB). We deliberately
    // do NOT run db:push / DROP here: this DB is shared and pre-migrated.
    const check = await db.execute(sql`
      SELECT to_regclass('ledger_entries') AS l, to_regclass('processed_events') AS p
    `)
    const row = check.rows[0] as { l: string | null, p: string | null }
    if (!row.l || !row.p) {
      throw new Error('ledger_entries / processed_events tables are missing; run migrations first')
    }
  })

  afterAll(async () => {
    // Remove only this run's rows (non-destructive to existing data).
    await db.execute(sql`DELETE FROM ledger_entries WHERE event_id LIKE ${`${RUN_ID}%`}`)
    await db.execute(sql`DELETE FROM processed_events WHERE event_id LIKE ${`${RUN_ID}%`}`)
    await pool.end()
  })

  it('rejects a missing signature with 401', async () => {
    const body = bodyFor()
    const res = await app.request('/webhooks/payment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(401)
  })

  it('rejects a malformed signature header with 401', async () => {
    const body = bodyFor()
    const res = await app.request('/webhooks/payment', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-signature': 'garbage' },
      body,
    })
    expect(res.status).toBe(401)
  })

  it('rejects a signature computed with the wrong secret with 401', async () => {
    const t = Math.floor(Date.now() / 1000)
    const body = bodyFor({ eventId: `${RUN_ID}wrong_secret` })
    const res = await app.request('/webhooks/payment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-signature': sign(t, body, 'not_the_secret'),
      },
      body,
    })
    expect(res.status).toBe(401)
  })

  it('rejects a tampered body (valid signature, mutated body) with 401', async () => {
    const t = Math.floor(Date.now() / 1000)
    const body = bodyFor({ eventId: `${RUN_ID}tampered`, data: { amount_cents: 999 } })
    const res = await app.request('/webhooks/payment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-signature': sign(t, body),
      },
      body: JSON.stringify({ ...JSON.parse(body), amount_cents: 1 }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects a stale timestamp (outside tolerance) with 401', async () => {
    const t = Math.floor(Date.now() / 1000) - 10_000
    const body = bodyFor({ eventId: `${RUN_ID}stale` })
    const res = await app.request('/webhooks/payment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-signature': sign(t, body),
      },
      body,
    })
    expect(res.status).toBe(401)
  })

  it('rejects malformed JSON with 400', async () => {
    const t = Math.floor(Date.now() / 1000)
    const raw = '{ not valid json'
    const res = await app.request('/webhooks/payment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-signature': sign(t, raw),
      },
      body: raw,
    })
    expect(res.status).toBe(400)
  })

  it('rejects negative amount_cents with 400', async () => {
    const t = Math.floor(Date.now() / 1000)
    const body = bodyFor({ eventId: `${RUN_ID}neg`, data: { amount_cents: -5 } })
    const res = await app.request('/webhooks/payment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-signature': sign(t, body),
      },
      body,
    })
    expect(res.status).toBe(400)
  })

  it('rejects unsupported currency with 400', async () => {
    const t = Math.floor(Date.now() / 1000)
    const body = bodyFor({ eventId: `${RUN_ID}currency`, data: { currency: 'USD' } })
    const res = await app.request('/webhooks/payment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-signature': sign(t, body),
      },
      body,
    })
    expect(res.status).toBe(400)
  })

  it('rejects missing required fields with 400', async () => {
    const t = Math.floor(Date.now() / 1000)
    const partial = JSON.stringify({
      event_id: `${RUN_ID}missing`,
      type: 'payment.succeeded',
      timestamp: '2026-08-13T12:00:00Z',
    })
    const res = await app.request('/webhooks/payment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-signature': sign(t, partial),
      },
      body: partial,
    })
    expect(res.status).toBe(400)
  })

  it('processes a valid webhook and returns 200', async () => {
    const t = Math.floor(Date.now() / 1000)
    const eventId = `${RUN_ID}valid`
    const body = bodyFor()
    const res = await app.request('/webhooks/payment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-signature': sign(t, body),
      },
      body,
    })
    expect(res.status).toBe(200)

    const rows = await db
      .select({ count: count() })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.eventId, eventId))
    expect(Number(rows[0].count)).toBe(1)

    const [entry] = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.eventId, eventId))
    expect(entry.customerEmail).toBe('u***l@example.com')
    expect(entry.currency).toBe('KES')
    expect(entry.amountCents).toBe(14999)
    expect(entry.source).toBe('webhook')

    // Dedup gate also recorded the event.
    const gates = await db
      .select({ count: count() })
      .from(processedEvents)
      .where(eq(processedEvents.eventId, eventId))
    expect(Number(gates[0].count)).toBe(1)
  })

  it('returns 200 for a duplicate event_id without inserting again', async () => {
    const t = Math.floor(Date.now() / 1000)
    const body = bodyFor()
    const res = await app.request('/webhooks/payment', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-signature': sign(t, body),
      },
      body,
    })
    expect(res.status).toBe(200)

    const rows = await db
      .select({ count: count() })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.eventId, `${RUN_ID}valid`))
    expect(Number(rows[0].count)).toBe(1)
  })

  it('handles concurrent duplicate deliveries exactly-once', async () => {
    const t = Math.floor(Date.now() / 1000)
    const eventId = `${RUN_ID}concurrent`
    const body = bodyFor({ eventId, data: { transaction_id: `${RUN_ID}concurrent_txn` } })
    const headers = {
      'content-type': 'application/json',
      'x-webhook-signature': sign(t, body),
    }
    const [a, b] = await Promise.all([
      app.request('/webhooks/payment', { method: 'POST', headers, body }),
      app.request('/webhooks/payment', { method: 'POST', headers, body }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)

    const rows = await db
      .select({ count: count() })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.eventId, eventId))
    expect(Number(rows[0].count)).toBe(1)
  })
})
