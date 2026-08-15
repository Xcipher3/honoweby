# Webhook Ledger API — Implemented Features

> Payment-gateway webhook ingestion with exactly-once semantics, a batch reconciliation CLI, and a production-scale PostgreSQL ledger.
> Stack: Hono + @hono/zod-openapi + stoker + pino + drizzle-orm (pg) + PostgreSQL 16 + Vitest.

---

## 1. Webhook ingestion (`POST /webhooks/payment`)

| Feature | Status | Notes |
| --- | --- | --- |
| HMAC-SHA256 signature verification (signature-first) | Implemented | Verified on RAW body before any JSON parsing |
| Replay protection (timestamp tolerance) | Implemented | `WEBHOOK_TOLERANCE_SECONDS` (default 300 s) |
| Strict idempotency (exactly-once) | Implemented | DB-level `ON CONFLICT (event_id) DO NOTHING`; duplicate → `200 OK`, no side effects |
| Append-only immutable ledger | Implemented | INSERT-only code paths; no `updatedAt` column |
| PII masking (`customer_email`) | Implemented | Masked in DB and in all logs |
| Currency lock | Implemented | Only `KES` accepted (400 otherwise) |
| SLA guard (retryable 503) | Implemented | 5000 ms cap; safe to retry due to idempotency |
| Structured audit logging | Implemented | pino JSON logs: event_id, masked email, outcome, latency |
| OpenAPI 3.1 spec + docs UI | Implemented | Scalar reference UI at `/reference` |
| Type safety | Implemented | `tsc --noEmit` clean |

## 2. Reconciliation CLI (`npm run reconcile`)

| Feature | Status | Notes |
| --- | --- | --- |
| Optional provider-file path argument | Implemented | Defaults to `./provider_transactions.json` in the working directory |
| Provider file ingestion + validation | Implemented | Zod-validated; invalid rows reported and skipped |
| Four-way classification | Implemented | Matched / Discrepancies / Missing Local / Orphan Local |
| Structured summary report | Implemented | Printed to stdout with counts and per-row details |
| Compensating writes | Implemented | Missing-local transactions inserted with `status = 'reconciled_missing'` |
| Idempotent re-runs | Implemented | Compensating inserts reuse the `processed_events` dedup gate |

## 3. Database schema & performance

| Feature | Status | Notes |
| --- | --- | --- |
| Production DDL (`schema.sql`) | Implemented | PKs, FK, unique constraints, indexes, full data types |
| Declarative partitioning | Implemented | `ledger_entries` partitioned by `RANGE (occurred_at)`; monthly partitions + DEFAULT |
| Covering balance index | Implemented | `(customer_email, status) INCLUDE (amount_cents)` → index-only scans |
| DB-level concurrency control | Implemented | Unique-constraint dedup gate; transaction-scoped advisory lock pattern documented |
| EXPLAIN verification tooling | Implemented | `npm run explain:balance` reproduces live plans |

## 4. Operations

| Feature | Status | Notes |
| --- | --- | --- |
| Containerized deployment | Implemented | Multi-stage Dockerfile; compose stack: db + migrate + api |
| Test suite | Implemented | 24 tests (webhooks, reconcile engine, end-to-end CLI) |
| Lint + typecheck | Implemented | `npm run lint` and `npm run typecheck` clean |
