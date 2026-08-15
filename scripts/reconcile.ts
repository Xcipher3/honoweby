import type { MissingLocalEntry } from '@/reconcile/engine'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import process from 'node:process'
import db, { pool } from '@/db'
import { ledgerEntries, processedEvents } from '@/db/schema'
import { parseProviderFile, reconcile } from '@/reconcile/engine'
import { formatReport } from '@/reconcile/format'

const DEFAULT_PROVIDER_PATH = 'provider_transactions.json'

async function insertCompensatingEntries(missing: MissingLocalEntry[]): Promise<number> {
  return db.transaction(async (tx) => {
    let inserted = 0
    for (const item of missing) {
      const eventId = `recon_${item.transaction_id}`
      const gate = await tx
        .insert(processedEvents)
        .values({
          eventId,
          transactionId: item.transaction_id,
        })
        .onConflictDoNothing()
        .returning({ eventId: processedEvents.eventId })

      if (gate.length === 0) {
        continue
      }

      await tx.insert(ledgerEntries).values({
        eventId,
        transactionId: item.transaction_id,
        amountCents: item.providerAmountCents,
        currency: item.providerCurrency,
        customerEmail: 'reconciled@system.local',
        status: 'reconciled_missing',
        eventType: 'reconciliation.compensating',
        occurredAt: new Date().toISOString(),
        source: 'reconciliation',
      })
      inserted += 1
    }
    return inserted
  })
}

async function main(): Promise<void> {
  const providerPath = process.argv[2] ?? DEFAULT_PROVIDER_PATH
  const resolvedPath = path.resolve(process.cwd(), providerPath)

  let contents: string
  try {
    contents = readFileSync(resolvedPath, 'utf8')
  }
  catch {
    console.error(`reconcile: cannot read provider file: ${resolvedPath}`)
    process.exitCode = 1
    return
  }

  const { transactions, errors } = parseProviderFile(contents)

  if (transactions.length === 0 && errors.length > 0) {
    console.error(`reconcile: provider file is unreadable: ${errors[0].issue}`)
    process.exitCode = 1
    return
  }

  const ledgerRows = await db
    .select({
      transaction_id: ledgerEntries.transactionId,
      amount_cents: ledgerEntries.amountCents,
      currency: ledgerEntries.currency,
    })
    .from(ledgerEntries)

  const report = reconcile(transactions, ledgerRows)

  console.log(formatReport(report, {
    providerPath: resolvedPath,
    providerRowCount: transactions.length,
    ledgerRowCount: ledgerRows.length,
    skippedRows: errors.length,
  }))

  if (report.missingLocal.length > 0) {
    const inserted = await insertCompensatingEntries(report.missingLocal)
    console.log(`\nCompensating ledger entries inserted: ${inserted}`)
  }
  else {
    console.log('\nNo compensating ledger entries needed.')
  }
}

await main().catch((err: unknown) => {
  console.error(`reconcile: ${String(err)}`)
  process.exitCode = 1
}).finally(async () => {
  await pool.end()
})
