import { bigint, bigserial, char, index, pgTable, primaryKey, text, timestamp, unique } from 'drizzle-orm/pg-core'

/**
 * Idempotency gate. Mirrors the existing `processed_events` table:
 * `event_id` is the PRIMARY KEY, so `ON CONFLICT (event_id) DO NOTHING`
 * deduplicates exactly-once at the database layer. `transaction_id` is
 * also UNIQUE, so a duplicate underlying transaction is rejected too.
 * Rows are INSERT-only.
 */
export const processedEvents = pgTable('processed_events', {
  eventId: text('event_id').notNull(),
  transactionId: text('transaction_id').notNull(),
  processedAt: timestamp('processed_at', { mode: 'string', withTimezone: true })
    .notNull()
    .defaultNow(),
}, table => [
  primaryKey({ name: 'processed_events_pkey', columns: [table.eventId] }),
  unique('processed_events_transaction_id_key').on(table.transactionId),
])

/**
 * Immutable, append-only financial ledger. Mirrors the existing
 * `ledger_entries` table: composite PK `(id, occurred_at)`, INSERT-only
 * code paths, no `updatedAt` column. `customer_email` stores the MASKED
 * address (PII protection in the DB).
 *
 * Physical layer applied via raw DDL (see schema.sql) because drizzle-orm
 * 0.44 cannot express it:
 *   - PARTITION BY RANGE (occurred_at) with monthly partitions
 *   - ledger_customer_status_idx covering index:
 *     (customer_email, status) INCLUDE (amount_cents)  -> index-only balance scans
 */
export const ledgerEntries = pgTable('ledger_entries', {
  id: bigserial('id', { mode: 'number' }).notNull(),
  eventId: text('event_id').notNull(),
  transactionId: text('transaction_id').notNull(),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  customerEmail: text('customer_email').notNull(),
  status: text('status').notNull(),
  eventType: text('event_type').notNull(),
  occurredAt: timestamp('occurred_at', { mode: 'string', withTimezone: true }).notNull(),
  recordedAt: timestamp('recorded_at', { mode: 'string', withTimezone: true })
    .notNull()
    .defaultNow(),
  source: text('source').notNull().default('webhook'),
}, table => [
  primaryKey({ name: 'ledger_entries_pkey', columns: [table.id, table.occurredAt] }),
  index('ledger_occurred_at_idx').on(table.occurredAt),
  index('ledger_transaction_id_idx').on(table.transactionId),
])

export type ProcessedEvent = typeof processedEvents.$inferSelect
export type LedgerEntry = typeof ledgerEntries.$inferSelect
