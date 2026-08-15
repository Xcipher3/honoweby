import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { count, eq, sql } from 'drizzle-orm'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import db, { pool } from '@/db'
import { ledgerEntries } from '@/db/schema'
import env from '@/env'

if (env.NODE_ENV !== 'test') {
  throw new Error('NODE_ENV must be \'test\'')
}

const RUN_ID = `recon_${Date.now()}_`
const TMP_DIR = mkdtempSync(path.join(tmpdir(), 'reconcile-'))

function runCli(providerPath: string): { status: number | null, stdout: string, stderr: string } {
  const res = spawnSync(
    process.execPath,
    [path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), path.resolve(process.cwd(), 'scripts/reconcile.ts'), providerPath],
    {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test' },
      encoding: 'utf8',
    },
  )
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

describe('reconcile CLI (end-to-end)', () => {
  beforeAll(async () => {
    const seeds: Array<[string, number]> = [
      [`${RUN_ID}matched`, 14999],
      [`${RUN_ID}discrepancy`, 1000],
    ]
    for (const [txn, amount] of seeds) {
      await db.insert(ledgerEntries).values({
        eventId: `seed_${txn}`,
        transactionId: txn,
        amountCents: amount,
        currency: 'KES',
        customerEmail: 'u***r@example.com',
        status: 'completed',
        eventType: 'payment.succeeded',
        occurredAt: '2026-08-13T12:00:00Z',
        source: 'webhook',
      })
    }
    await db.insert(ledgerEntries).values({
      eventId: `seed_${RUN_ID}orphan`,
      transactionId: `${RUN_ID}orphan`,
      amountCents: 700,
      currency: 'KES',
      customerEmail: 'u***r@example.com',
      status: 'completed',
      eventType: 'payment.succeeded',
      occurredAt: '2026-08-13T12:00:00Z',
      source: 'webhook',
    })
  })

  afterAll(async () => {
    await db.execute(sql`DELETE FROM ledger_entries WHERE event_id LIKE ${`seed_${RUN_ID}%`} OR event_id LIKE ${`recon_${RUN_ID}%`}`)
    rmSync(TMP_DIR, { recursive: true, force: true })
    await pool.end()
  })

  it('classifies all four buckets and inserts compensating entries', async () => {
    const fixturePath = path.join(TMP_DIR, 'fixture.json')
    writeFileSync(fixturePath, JSON.stringify([
      { transaction_id: `${RUN_ID}matched`, amount_cents: 14999, currency: 'KES' },
      { transaction_id: `${RUN_ID}discrepancy`, amount_cents: 1500, currency: 'KES' },
      { transaction_id: `${RUN_ID}missing`, amount_cents: 2500, currency: 'KES' },
    ]))

    const { status, stdout } = runCli(fixturePath)
    expect(status).toBe(0)
    expect(stdout).toContain('MATCHED (1)')
    expect(stdout).toContain('DISCREPANCIES (1)')
    expect(stdout).toContain('MISSING LOCAL (1)')
    expect(stdout).toMatch(/ORPHAN LOCAL \(\d+\)/)
    expect(stdout).toContain('Compensating ledger entries inserted: 1')

    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, `${RUN_ID}missing`))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      amountCents: 2500,
      currency: 'KES',
      status: 'reconciled_missing',
      eventType: 'reconciliation.compensating',
      source: 'reconciliation',
    })
  }, 30_000)

  it('is idempotent on re-run (no duplicate compensating entries)', async () => {
    const fixturePath = path.join(TMP_DIR, 'fixture.json')

    const { status, stdout } = runCli(fixturePath)
    expect(status).toBe(0)
    expect(stdout).toContain('MATCHED (2)')
    expect(stdout).toContain('MISSING LOCAL (0)')
    expect(stdout).toContain('No compensating ledger entries needed.')

    const rows = await db
      .select({ count: count() })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, `${RUN_ID}missing`))
    expect(Number(rows[0].count)).toBe(1)
  }, 30_000)

  it('exits non-zero when the provider file is missing', () => {
    const { status, stderr } = runCli(path.join(TMP_DIR, 'does-not-exist.json'))
    expect(status).not.toBe(0)
    expect(stderr).toContain('cannot read provider file')
  })
})
