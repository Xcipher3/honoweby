import type { LedgerMatch, MissingLocalEntry, OrphanLocalEntry, ReconciliationReport } from './engine'

const CENTS_PER_UNIT = 100
const DEFAULT_MAX_ROWS = 50

export interface FormatOptions {
  providerPath: string
  providerRowCount: number
  ledgerRowCount: number
  skippedRows: number
  maxRows?: number
}

function formatAmount(cents: number, currency: string): string {
  return `${(cents / CENTS_PER_UNIT).toFixed(2)} ${currency}`
}

function renderList(
  rows: Array<{ transaction_id: string, detail: string }>,
  maxRows: number,
): string[] {
  const shown = rows.slice(0, maxRows)
  const lines = shown.map(r => `  ${r.transaction_id.padEnd(24)} ${r.detail}`)
  const remainder = rows.length - shown.length
  if (remainder > 0) {
    lines.push(`  ... and ${remainder} more`)
  }
  return lines
}

export function formatReport(report: ReconciliationReport, opts: FormatOptions): string {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS

  const lines: string[] = [
    'RECONCILIATION SUMMARY',
    `  Provider file   : ${opts.providerPath}`,
    `  Provider rows   : ${opts.providerRowCount}${opts.skippedRows > 0 ? ` (${opts.skippedRows} invalid rows skipped)` : ''}`,
    `  Ledger rows     : ${opts.ledgerRowCount}`,
    '',
  ]

  const matched = renderList(
    report.matched.map((m: LedgerMatch) => ({ transaction_id: m.transaction_id, detail: formatAmount(m.providerAmountCents, m.providerCurrency) })),
    maxRows,
  )
  lines.push(`MATCHED (${report.matched.length})`, ...matched, '')

  const discrepancies = renderList(
    report.discrepancies.map((d: LedgerMatch) => ({
      transaction_id: d.transaction_id,
      detail: `provider: ${formatAmount(d.providerAmountCents, d.providerCurrency)} | ledger: ${formatAmount(d.ledgerAmountCents, d.ledgerCurrency)}`,
    })),
    maxRows,
  )
  lines.push(`DISCREPANCIES (${report.discrepancies.length})`, ...discrepancies, '')

  const missing = renderList(
    report.missingLocal.map((m: MissingLocalEntry) => ({ transaction_id: m.transaction_id, detail: formatAmount(m.providerAmountCents, m.providerCurrency) })),
    maxRows,
  )
  lines.push(`MISSING LOCAL (${report.missingLocal.length})`, ...missing, '')

  const orphans = renderList(
    report.orphanLocal.map((o: OrphanLocalEntry) => ({ transaction_id: o.transaction_id, detail: formatAmount(o.ledgerAmountCents, o.ledgerCurrency) })),
    maxRows,
  )
  lines.push(`ORPHAN LOCAL (${report.orphanLocal.length})`, ...orphans)

  return lines.join('\n')
}
