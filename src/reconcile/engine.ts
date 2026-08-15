import { z } from 'zod'

export const providerTransactionSchema = z.object({
  transaction_id: z.string().min(1),
  amount_cents: z.number().int().nonnegative(),
  currency: z.string().min(1).max(3),
})

export type ProviderTransaction = z.infer<typeof providerTransactionSchema>

export interface LedgerEntryRow {
  transaction_id: string
  amount_cents: number
  currency: string
}

export interface LedgerMatch {
  transaction_id: string
  providerAmountCents: number
  providerCurrency: string
  ledgerAmountCents: number
  ledgerCurrency: string
}

export interface MissingLocalEntry {
  transaction_id: string
  providerAmountCents: number
  providerCurrency: string
}

export interface OrphanLocalEntry {
  transaction_id: string
  ledgerAmountCents: number
  ledgerCurrency: string
}

export interface ReconciliationReport {
  matched: LedgerMatch[]
  discrepancies: LedgerMatch[]
  missingLocal: MissingLocalEntry[]
  orphanLocal: OrphanLocalEntry[]
}

export interface ParseResult {
  transactions: ProviderTransaction[]
  errors: { index: number, issue: string }[]
}

export function parseProviderFile(contents: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(contents)
  }
  catch (err) {
    return { transactions: [], errors: [{ index: -1, issue: `invalid JSON: ${String(err)}` }] }
  }

  if (!Array.isArray(raw)) {
    return { transactions: [], errors: [{ index: -1, issue: 'expected a top-level JSON array' }] }
  }

  const transactions: ProviderTransaction[] = []
  const errors: { index: number, issue: string }[] = []

  raw.forEach((row, index) => {
    const parsed = providerTransactionSchema.safeParse(row)
    if (parsed.success) {
      transactions.push(parsed.data)
      return
    }
    errors.push({
      index,
      issue: parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    })
  })

  return { transactions, errors }
}

export function reconcile(
  provider: ProviderTransaction[],
  ledger: LedgerEntryRow[],
): ReconciliationReport {
  const providerById = new Map<string, ProviderTransaction>()
  for (const p of provider) {
    providerById.set(p.transaction_id, p)
  }

  const ledgerById = new Map(ledger.map(row => [row.transaction_id, row]))

  const report: ReconciliationReport = {
    matched: [],
    discrepancies: [],
    missingLocal: [],
    orphanLocal: [],
  }

  for (const [transactionId, p] of providerById) {
    const l = ledgerById.get(transactionId)
    if (!l) {
      report.missingLocal.push({
        transaction_id: transactionId,
        providerAmountCents: p.amount_cents,
        providerCurrency: p.currency,
      })
      continue
    }

    const item = {
      transaction_id: transactionId,
      providerAmountCents: p.amount_cents,
      providerCurrency: p.currency,
      ledgerAmountCents: l.amount_cents,
      ledgerCurrency: l.currency,
    }

    if (l.amount_cents === p.amount_cents && l.currency === p.currency) {
      report.matched.push(item)
    }
    else {
      report.discrepancies.push(item)
    }
  }

  for (const [transactionId, l] of ledgerById) {
    if (!providerById.has(transactionId)) {
      report.orphanLocal.push({
        transaction_id: transactionId,
        ledgerAmountCents: l.amount_cents,
        ledgerCurrency: l.currency,
      })
    }
  }

  return report
}
