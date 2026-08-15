import { describe, expect, it } from 'vitest'

import { parseProviderFile, reconcile } from './engine'

describe('parseProviderFile', () => {
  it('parses a valid array of transactions', () => {
    const { transactions, errors } = parseProviderFile(JSON.stringify([
      { transaction_id: 'txn_1', amount_cents: 14999, currency: 'KES' },
      { transaction_id: 'txn_2', amount_cents: 5000, currency: 'KES' },
    ]))
    expect(errors).toEqual([])
    expect(transactions).toHaveLength(2)
    expect(transactions[0]).toEqual({ transaction_id: 'txn_1', amount_cents: 14999, currency: 'KES' })
  })

  it('rejects malformed JSON', () => {
    const { transactions, errors } = parseProviderFile('{ not json')
    expect(transactions).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0].index).toBe(-1)
  })

  it('rejects a non-array document', () => {
    const { transactions, errors } = parseProviderFile('{"transaction_id": "txn_1"}')
    expect(transactions).toEqual([])
    expect(errors[0].issue).toContain('array')
  })

  it('reports invalid rows with their index while keeping valid ones', () => {
    const { transactions, errors } = parseProviderFile(JSON.stringify([
      { transaction_id: 'txn_ok', amount_cents: 100, currency: 'KES' },
      { transaction_id: 'txn_bad_amount', amount_cents: -5, currency: 'KES' },
      { transaction_id: 'txn_bad_currency', amount_cents: 100, currency: 'KESLONG' },
    ]))
    expect(transactions).toHaveLength(1)
    expect(transactions[0].transaction_id).toBe('txn_ok')
    expect(errors).toHaveLength(2)
    expect(errors[0].index).toBe(1)
    expect(errors[1].index).toBe(2)
  })
})

describe('reconcile', () => {
  const provider = [
    { transaction_id: 'txn_matched', amount_cents: 100, currency: 'KES' },
    { transaction_id: 'txn_amount_diff', amount_cents: 150, currency: 'KES' },
    { transaction_id: 'txn_currency_diff', amount_cents: 100, currency: 'KES' },
    { transaction_id: 'txn_missing_local', amount_cents: 250, currency: 'KES' },
  ]
  const ledger = [
    { transaction_id: 'txn_matched', amount_cents: 100, currency: 'KES' },
    { transaction_id: 'txn_amount_diff', amount_cents: 120, currency: 'KES' },
    { transaction_id: 'txn_currency_diff', amount_cents: 100, currency: 'USD' },
    { transaction_id: 'txn_orphan_local', amount_cents: 999, currency: 'KES' },
  ]

  const report = reconcile(provider, ledger)

  it('classifies exact matches', () => {
    expect(report.matched).toHaveLength(1)
    expect(report.matched[0].transaction_id).toBe('txn_matched')
  })

  it('classifies amount and currency discrepancies', () => {
    expect(report.discrepancies).toHaveLength(2)
    const byId = new Map(report.discrepancies.map(d => [d.transaction_id, d]))
    expect(byId.get('txn_amount_diff')).toMatchObject({ providerAmountCents: 150, ledgerAmountCents: 120 })
    expect(byId.get('txn_currency_diff')).toMatchObject({ providerCurrency: 'KES', ledgerCurrency: 'USD' })
  })

  it('classifies provider-only rows as missing local', () => {
    expect(report.missingLocal).toHaveLength(1)
    expect(report.missingLocal[0]).toMatchObject({ transaction_id: 'txn_missing_local', providerAmountCents: 250 })
  })

  it('classifies ledger-only rows as orphan local', () => {
    expect(report.orphanLocal).toHaveLength(1)
    expect(report.orphanLocal[0]).toMatchObject({ transaction_id: 'txn_orphan_local', ledgerAmountCents: 999 })
  })

  it('deduplicates duplicate provider transaction ids', () => {
    const dupes = reconcile([
      { transaction_id: 't1', amount_cents: 1, currency: 'KES' },
      { transaction_id: 't1', amount_cents: 1, currency: 'KES' },
    ], [{ transaction_id: 't1', amount_cents: 1, currency: 'KES' }])
    expect(dupes.matched).toHaveLength(1)
    expect(dupes.missingLocal).toHaveLength(0)
    expect(dupes.discrepancies).toHaveLength(0)
  })
})
