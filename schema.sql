-- Production schema for the payment ledger.
-- Target: PostgreSQL 16+ (verified against the deployed Neon database).
--
-- Design notes:
--   * ledger_entries is declaratively partitioned by RANGE (occurred_at) so the
--     table can scale past 50M rows and old months can be archived by
--     DETACH PARTITION (never DELETE) - see README "Task 4 - Part A".
--   * Uniqueness of (transaction_id) is enforced at the ingestion gate
--     (processed_events), not on the ledger itself. A partitioned table can
--     only hold unique constraints that include the partition key, so a
--     global UNIQUE (transaction_id) is impossible; the gate table is the
--     authoritative exactly-once mechanism (see README "Task 3 - Part B").
--   * ledger_customer_status_idx is a covering index (INCLUDE amount_cents)
--     that turns the balance query into an index-only scan.

CREATE TABLE processed_events (
  event_id       text PRIMARY KEY,
  transaction_id text NOT NULL UNIQUE,
  processed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id             bigserial NOT NULL,
  event_id       text NOT NULL REFERENCES processed_events (event_id),
  transaction_id text NOT NULL,
  amount_cents   bigint NOT NULL,
  currency       char(3) NOT NULL,
  customer_email text NOT NULL,
  status         text NOT NULL,
  event_type     text NOT NULL,
  occurred_at    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  source         text NOT NULL DEFAULT 'webhook',
  CONSTRAINT ledger_entries_pkey PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX ledger_occurred_at_idx
  ON ledger_entries (occurred_at);

CREATE INDEX ledger_transaction_id_idx
  ON ledger_entries (transaction_id);

CREATE INDEX ledger_customer_status_idx
  ON ledger_entries (customer_email, status)
  INCLUDE (amount_cents);

-- Monthly partitions. A scheduler (e.g. pg_cron) should create future months
-- ahead of time; the DEFAULT partition absorbs anything missed so inserts
-- never fail, at the cost of skipping partition pruning for those rows.
CREATE TABLE ledger_entries_2026_07 PARTITION OF ledger_entries
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE ledger_entries_2026_08 PARTITION OF ledger_entries
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE ledger_entries_2026_09 PARTITION OF ledger_entries
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE ledger_entries_default PARTITION OF ledger_entries DEFAULT;

-- Zero-downtime variant for an existing table (create per-partition, attach):
--   CREATE INDEX ledger_customer_status_idx
--     ON ONLY ledger_entries (customer_email, status) INCLUDE (amount_cents);
--   CREATE INDEX ... ON ONLY ledger_entries_2026_07 (customer_email, status) INCLUDE (amount_cents);
--   ALTER INDEX ledger_customer_status_idx ATTACH PARTITION ...;
--
-- NOTE (FK): the FK ledger_entries.event_id -> processed_events.event_id is
-- part of the production design but is NOT yet enforced on the deployed demo
-- database: legacy seed rows (event_id = 'seed_txn_*') have no matching
-- processed_events row. Enforce it after a data-quality pass:
--   ALTER TABLE ledger_entries
--     ADD CONSTRAINT ledger_entries_event_id_fkey
--     FOREIGN KEY (event_id) REFERENCES processed_events (event_id);
