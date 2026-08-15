# Webhook Ledger API

Payment-gateway webhook ingestion with exactly-once semantics, a batch reconciliation CLI, and a production-scale PostgreSQL ledger design.

Stack: Hono + zod-openapi + Drizzle ORM (pg) + PostgreSQL 16 (Neon) + Vitest + tsx.

---

## Setup

```bash
npm install

# Option A: full stack in Docker (Postgres + schema migration + API)
docker compose up -d --build
#   - API:     http://localhost:3000  (OpenAPI docs at /reference)
#   - Postgres: localhost:5432

# Option B: local Postgres only, API on the host
docker compose up -d db
cp .env.example .env   # point DATABASE_URL at localhost or keep Neon
npm run dev            # API on http://localhost:3000

# Option C: remote Postgres (Neon)
cp .env.example .env   # set DATABASE_URL + WEBHOOK_SECRET
npm run dev

npm test               # full suite (webhooks + reconciliation)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint (antfu config)
```

### Prerequisites & installing Hono

Requires Node 20+ and npm. This repo pins all dependencies, so for this project a plain `npm install` is all you need. To bootstrap a Hono app from scratch:

```bash
npm create hono@latest         # official starter (or follow the docs at hono.dev)
npm i hono @hono/node-server   # Hono core + Node adapter
npm i @hono/zod-openapi        # Zod validation + OpenAPI spec generation
```

### Installing the rest of the stack (OpenAPI docs, DB, logging, tooling)

**OpenAPI 3.1 spec + interactive docs UI** - routes defined with `@hono/zod-openapi` generate the spec at runtime; the Scalar reference UI mounts it at `/reference`:

```bash
npm i @hono/zod-openapi zod    # one source of truth: Zod schema -> validation + spec
npm i @scalar/hono-api-reference  # docs UI (GET /reference)
npm i stoker                   # middleware/helper kit used across the app
```

**Database access** - Drizzle ORM over the `pg` driver:

```bash
npm i drizzle-orm pg
npm i -D drizzle-kit @types/pg # schema push + CLI tooling
```

**Structured logging** - pino via the Hono adapter:

```bash
npm i pino hono-pino pino-pretty
```

**Development tooling** - TypeScript, tsx (run/build TS directly), tsc-alias (resolve `@/` path aliases in the build output), Vitest, ESLint:

```bash
npm i -D typescript tsx tsc-alias vitest cross-env @antfu/eslint-config
```

See `package.json` for the exact pinned versions used here.

### Getting a Neon database

1. Create a free account at <https://neon.tech> and create a project.
2. Copy the pooled connection string from the dashboard:
   `postgresql://<user>:<password>@ep-<id>-pooler.c-4.us-east-2.aws.neon.tech/neondb?sslmode=require`
3. Set it as `DATABASE_URL` in `.env` (see `.env.example` for the other vars).
4. Apply the schema:
   `psql "$DATABASE_URL" -f schema.sql`
   (or paste the contents of `schema.sql` into the SQL editor in the Neon console).

`src/env.ts` validates configuration at startup from `.env` (dev) or `.env.test` (test). The database schema is provisioned by `schema.sql` (see below); the deployed Neon database already matches it, including monthly partitions. The `api` image is a multi-stage build (deps -> build -> slim runtime, non-root `node` user, healthcheck); it runs the compiled output, not tsx. Reconciliation and EXPLAIN scripts are host-side tooling (`npm run reconcile`, `npm run explain:balance`), so they are intentionally not packaged into the image.

---

## Browser testing with the OpenAPI UI

### 1. Run the servers

Start the API together with its database. Either option below brings up the same service at `http://localhost:3000`:

```bash
# Full stack in Docker (Postgres + migration + API)
docker compose up -d --build

# Or API on the host against any Postgres (local or Neon)
npm run dev
```

Confirm the API is healthy: `GET /` returns `200 OK` and the healthcheck passes.

### 2. Open the API reference

Navigate to <http://localhost:3000/reference> - an interactive Scalar docs UI generated at runtime from the Zod route schemas (the raw OpenAPI 3.1 spec is served at `/doc`). You will see the API description, the request/response schemas, and the documented status codes for each route.

### 3. Send an authenticated request

1. Expand `POST /webhooks/payment` and click **Test Request**. The body editor is pre-filled from the schema.
2. Add the `x-webhook-signature` request header. This is a signature-first API: every request must be signed with the webhook secret, otherwise it is rejected with `401`.
3. Click **Send** and inspect the response (`200 Acknowledged` for a valid event).

**Generating a signature** - `HMAC-SHA256` over `t.<rawBody>` using `WEBHOOK_SECRET` (`dev_secret_change_me` in dev). The body you sign must be byte-identical to the body you send:

```powershell
$body = '{"event_id":"evt_demo_1","type":"payment.succeeded","timestamp":"2026-08-16T10:00:00Z","data":{"transaction_id":"txn_demo_1","amount_cents":14999,"currency":"KES","customer_email":"user@example.com","status":"completed"}}'
$t = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes('dev_secret_change_me'))
$hex = [Convert]::ToHexString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("$t.$body"))).ToLower()
Write-Host "t=$t,v1=$hex"
```

Paste the output as the header value and send.

### 4. Validate the expected behavior

| Action | Result |
| --- | --- |
| Valid signature + fresh timestamp | `200` - event appended to the ledger |
| Re-send the same `event_id` | `200` - idempotent ack, no duplicate row |
| Wrong secret / tampered body | `401 Unauthorized` |
| Timestamp older than `WEBHOOK_TOLERANCE_SECONDS` | `401` - stale timestamp |
| Negative `amount_cents` or non-`KES` currency | `400 Bad Request` |

The same flow is covered end-to-end by the automated test suite (`npm test`).

---

## Task 1 - Webhook ingestion (`POST /webhooks/payment`)

- **Signature-first security**: HMAC-SHA256 over the raw body (`t.<raw_body>`, Stripe-style `x-webhook-signature` header) verified before any parsing; `timingSafeEqual` constant-time compare; stale-timestamp replay protection (`WEBHOOK_TOLERANCE_SECONDS`).
- **Exactly-once idempotency**: a single transaction inserts into the `processed_events` gate (`event_id` PK, `transaction_id` UNIQUE) with `ON CONFLICT DO NOTHING`; a winner appends to `ledger_entries`, a loser no-ops with `200 OK`. Concurrent duplicate deliveries are proven exactly-once by the test suite.
- **Append-only ledger**: INSERT-only code paths, no `updatedAt`, PII-masked `customer_email` in storage and logs, `KES` currency lock, retryable `503` on a 5s DB SLA.

---

## Task 2 - Reconciliation CLI (`scripts/reconcile.ts`)

Syncs the local ledger against an upstream provider transcript to recover from dropped connections or missed webhooks.

```bash
npm run reconcile                          # uses ./provider_transactions.json (default)
npm run reconcile -- /path/to/file.json    # explicit provider file
```

Provider file format (`provider_transactions.json`):

```json
[
  { "transaction_id": "txn_abc123xyz", "amount_cents": 14999, "currency": "KES" },
  { "transaction_id": "txn_def456uvw", "amount_cents": 5000, "currency": "KES" }
]
```

The tool loads and Zod-validates the provider file (invalid rows are reported and skipped), compares against `ledger_entries`, and prints a structured summary to stdout:

```
RECONCILIATION SUMMARY
  Provider file   : C:\...\provider_transactions.json
  Provider rows   : 4
  Ledger rows     : 25016

MATCHED (4)
  txn_abc123xyz            149.99 KES

DISCREPANCIES (0)

MISSING LOCAL (0)

ORPHAN LOCAL (25012)
  seed_txn_6               6742.10 EUR
  ... and 24962 more

No compensating ledger entries needed.
```

| Bucket | Definition |
| --- | --- |
| `MATCHED` | Transaction ID in both datasets; amount and currency equal |
| `DISCREPANCIES` | Transaction ID matches; amount or currency differs |
| `MISSING LOCAL` | In provider file, absent from the local ledger |
| `ORPHAN LOCAL` | In local ledger, absent from the provider file |

**Compensating writes**: every missing-local transaction is inserted as a ledger row with `status = 'reconciled_missing'`, `source = 'reconciliation'`, deterministic `event_id = 'recon_' + transaction_id`, masked `customer_email`, preserving the provider amount/currency. Historical entries are never modified.

**Idempotency**: compensating inserts first acquire the same dedup gate as the webhook path (`processed_events` with `ON CONFLICT DO NOTHING`), so re-runs classify previous compensating rows as `MATCHED` and insert nothing (proven by an end-to-end test that re-runs the CLI).

---

## Task 3 - Database performance, concurrency & locking

### Part A - Schema (`schema.sql`)

Full DDL: data types, primary keys, foreign keys, unique constraints, and indexes, targeting 50M+ ledger rows.

Core design:

- `processed_events` - idempotency gate: `event_id` PK, `transaction_id` UNIQUE.
- `ledger_entries` - **declaratively partitioned `PARTITION BY RANGE (occurred_at)`** (monthly partitions + a `DEFAULT` partition so inserts never fail), composite PK `(id, occurred_at)`, FK to `processed_events(event_id)`.
- Indexes: `ledger_occurred_at_idx (occurred_at)` (partition pruning), `ledger_transaction_id_idx (transaction_id)` (reconciliation lookups), and the covering balance index `ledger_customer_status_idx (customer_email, status) INCLUDE (amount_cents)`.

Drizzle 0.44 cannot express `PARTITION BY` or `INCLUDE` columns, so `schema.sql` is the physical-layer source of truth; `src/db/schema.ts` mirrors the logical schema (see its doc block). Note: the FK is part of the production design but not yet enforced on the deployed demo DB (legacy `seed_txn_*` rows have no gate row); the migration is documented in `schema.sql`.

### Part B - Concurrency control

Two identical webhook payloads arriving at the exact same millisecond across multiple app servers cannot double-post. The design is race-free at the database layer:

```sql
INSERT INTO processed_events (event_id, transaction_id)
VALUES ($1, $2)
ON CONFLICT (event_id) DO NOTHING
RETURNING event_id;
```

The `processed_events` PK/unique constraints serialize concurrent inserts: exactly one transaction wins the conflict; every loser's insert is a no-op, and because the gate insert and ledger append share one transaction, losers append nothing. This is stronger than "check then insert" (TOCTOU-free) and does not depend on clock ordering, request timing, or a single node. The concurrent-duplicate webhook test proves it.

For invariants that are not expressible as unique constraints (e.g., "one active refund per customer per day"), PostgreSQL provides **transaction-scoped advisory locks**, which auto-release on commit/rollback and coordinate across all app servers:

```sql
BEGIN;
SELECT pg_try_advisory_xact_lock(hashtext('refund_lock:' || customer_email)) AS acquired;
-- acquired = false -> another worker is handling this customer; abort safely.
-- acquired = true  -> protected work is safe against concurrent nodes.
COMMIT;
```

Prefer constraints first; use advisory locks only for invariants with no natural row or uniqueness to lock.

### Part C - Balance calculation optimization

The query under analysis:

```sql
SELECT SUM(amount_cents)
FROM ledger_entries
WHERE customer_email = 'user@example.com' AND status = 'completed';
```

Indexing strategy: a **covering index** on the exact predicate columns with the aggregated column included, so the query never touches the heap:

```sql
CREATE INDEX ledger_customer_status_idx
  ON ledger_entries (customer_email, status)
  INCLUDE (amount_cents);
```

Reproduce live with `npm run explain:balance` (`scripts/explain-balance.ts`). Real output from the deployed database (25,016 rows, 15,000 `completed` for `heavy@example.com`; monthly partitions `2026_07`..`2026_09`):

**Spec query (zero rows for `user@example.com`) - index-only scan, no heap access:**

```
Aggregate  (cost=21.96..21.97 rows=1 width=32) (actual time=0.062..0.062 rows=1.00 loops=1)
  Buffers: shared hit=9
  ->  Append  (cost=0.29..21.85 rows=40 width=8) (actual time=0.059..0.060 rows=0.00 loops=1)
        Buffers: shared hit=9
        ->  Index Only Scan using ledger_entries_2026_07_customer_email_status_amount_cents_idx on ledger_entries_2026_07 ledger_entries_1  (cost=0.29..8.54 rows=13 width=8) (actual time=0.017..0.017 rows=0.00 loops=1)
              Index Cond: ((customer_email = 'user@example.com'::text) AND (status = 'completed'::text))
              Heap Fetches: 0
              Index Searches: 1
              Buffers: shared hit=3
        ->  Index Only Scan using ledger_entries_2026_08_customer_email_status_amount_cents_idx on ledger_entries_2026_08 ledger_entries_2  (cost=0.29..8.57 rows=14 width=8) (actual time=0.006..0.006 rows=0.00 loops=1)
              Index Cond: ((customer_email = 'user@example.com'::text) AND (status = 'completed'::text))
              Heap Fetches: 0
              Index Searches: 1
              Buffers: shared hit=3
        ->  Index Only Scan using ledger_entries_2026_09_customer_email_status_amount_cents_idx on ledger_entries_2026_09 ledger_entries_3  (cost=0.28..4.54 rows=13 width=8) (actual time=0.035..0.035 rows=0.00 loops=1)
              Index Cond: ((customer_email = 'user@example.com'::text) AND (status = 'completed'::text))
              Heap Fetches: 0
              Index Searches: 1
              Buffers: shared hit=3
Planning Time: 0.255 ms
Execution Time: 0.091 ms
```

**15,000-row customer (natural planner choice) - index-only scans on all partitions with one bounded seq scan:**

```
Aggregate  (cost=967.17..967.18 rows=1 width=32) (actual time=4.264..4.266 rows=1.00 loops=1)
  Buffers: shared hit=247
  ->  Append  (cost=0.29..929.66 rows=15000 width=8) (actual time=0.028..3.333 rows=15000.00 loops=1)
        Buffers: shared hit=247
        ->  Index Only Scan using ledger_entries_2026_07_customer_email_status_amount_cents_idx on ledger_entries_2026_07 ledger_entries_1  (cost=0.29..288.65 rows=5064 width=8) (actual time=0.028..0.614 rows=5064.00 loops=1)
              Index Cond: ((customer_email = 'heavy@example.com'::text) AND (status = 'completed'::text))
              Heap Fetches: 0
              Index Searches: 1
              Buffers: shared hit=37
        ->  Seq Scan on ledger_entries_2026_08 ledger_entries_2  (cost=0.00..301.33 rows=5116 width=8) (actual time=0.238..0.995 rows=5116.00 loops=1)
              Filter: ((customer_email = 'heavy@example.com'::text) AND (status = 'completed'::text))
              Rows Removed by Filter: 3384
              Buffers: shared hit=174
        ->  Index Only Scan using ledger_entries_2026_09_customer_email_status_amount_cents_idx on ledger_entries_2026_09 ledger_entries_3  (cost=0.28..264.68 rows=4820 width=8) (actual time=0.045..0.563 rows=4820.00 loops=1)
              Heap Fetches: 0
              Index Searches: 1
              Buffers: shared hit=36
Planning Time: 0.211 ms
Execution Time: 4.300 ms
```

Analysis: the query never performs a full-table scan. The one `Seq Scan` above is honest planner behavior on the *smallest* partition (8.5k rows) where 60% of rows match and index cost is not justified; forcing the index (`SET LOCAL enable_seqscan = off`) drops buffers from 247 to 112 and still finishes in ~3.9 ms. Partition pruning bounds any scan to a single month, and at 50M-row scale the planner selects the index-only path automatically for sparse predicates - `Heap Fetches: 0` confirms the `INCLUDE (amount_cents)` covering index eliminates heap access entirely.

---

## Task 4 - Architectural critique

### Part A - Data lifecycle & compliance

> "To save disk space on PostgreSQL, let's write a nightly cron job that deletes ledger entries older than 365 days."

**Why this is wrong:**

1. **Financial records are legally append-only.** GAAP/IFRS and SOX require a complete, tamper-evident audit trail; deleting ledger rows destroys the chain of custody that ties every balance to its supporting transactions. An auditor (or regulator) cannot reconcile a month-end balance if the underlying entries no longer exist.
2. **Deletion breaks reconstruction.** A `DELETE` is unrecoverable without backups, and backups cannot be relied on as "the archive" - they are versioned, not queried, and roll off.
3. **`DELETE` is also operationally expensive**: it bloats tables (dead tuples) and churns WAL, which costs *more* disk in the short term.

**Production-grade alternatives:**

- **Declarative partitioning** (as in `schema.sql`): retire a month by `ALTER TABLE ledger_entries DETACH PARTITION ledger_entries_2025_07;` - an O(1) metadata operation that requires no row rewrites and no long locks.
- **Cold storage archival**: `COPY (SELECT * FROM ledger_entries_2025_07) TO 's3://...'` (or `pg_dump --table` / `file_fdw` foreign tables pointing at S3), then archive the detached partition. Retention is a lifecycle policy, not a destructive job.
- **Bounded-hot storage**: keep e.g. 24 months online for customer self-service, archive older months to cheap object storage, and expose archived reads via foreign tables only when legally required.

### Part B - Distributed systems race condition

> "To fix duplicate webhook processing, let's add a `sleep(5)` delay in the API endpoint before checking the database so other threads finish first."

**Why this fails:**

1. **Timing is not synchronization.** Five seconds is arbitrary: two deliveries can still arrive 5 ms apart, or 6 s apart on a different network path; the sleep simply moves the race window without closing it.
2. **It does not serialize across nodes.** App servers are independent processes (possibly different machines); `sleep` in one thread has zero effect on another node's write.
3. **It destroys throughput and latency.** Every request now burns ≥5 s of connection/worker capacity, and under load the API degrades into a self-inflicted thundering herd - the exact outage webhooks are meant to survive.
4. **It masks, never detects, and is untestable** - a "fix" that cannot be reasoned about in a fault-injection test.

**The correct pattern** (implemented in Task 1): make processing idempotent *at the database layer* so that the race condition is converted into a well-defined no-op - `INSERT ... ON CONFLICT (event_id) DO NOTHING` on the dedup gate, with the gate and the ledger append in one transaction. Because the conflict is resolved by PostgreSQL's unique index at commit time, duplicates can arrive at any offset, from any node, in any order, and the outcome is identical: exactly one ledger row. For invariants without a natural uniqueness key, use transaction-scoped advisory locks (`pg_try_advisory_xact_lock`) or `SELECT ... FOR UPDATE`; never a sleep.

---

## Project structure

```
.
├── Dockerfile                     # multi-stage API image (deps -> build -> runtime)
├── docker-compose.yml             # stack: db + migrate + api
├── schema.sql                     # production DDL (partitioned ledger, covering index)
├── provider_transactions.json     # sample provider fixture for reconcile
├── scripts/
│   ├── reconcile.ts               # Task 2 reconciliation CLI (tsx)
│   └── explain-balance.ts         # Task 3 EXPLAIN (ANALYZE, BUFFERS) reproducer
└── src/
    ├── index.ts                   # entrypoint (@hono/node-server)
    ├── app.ts                     # app assembly + OpenAPI/Scalar mount
    ├── env.ts                     # Zod-validated environment (.env / .env.test)
    ├── db/
    │   ├── index.ts               # pg Pool + drizzle (snake_case)
    │   └── schema.ts              # drizzle table definitions
    ├── lib/
    │   ├── create-app.ts          # Hono app factory (+ createTestApp)
    │   ├── configure-open-api.ts  # OpenAPI + Scalar UI
    │   └── types.ts               # AppRouteHandler types
    ├── middlewares/
    │   └── pino-logger.ts         # hono-pino
    ├── reconcile/
    │   ├── engine.ts              # pure classification logic
    │   ├── format.ts              # pure summary rendering
    │   ├── engine.test.ts         # unit tests
    │   └── cli.test.ts            # end-to-end CLI tests
    └── routes/
        ├── index.route.ts         # GET /
        └── webhooks/
            ├── webhooks.routes.ts # OpenAPI route + Zod payload schema
            ├── webhooks.handlers.ts # signature verify, idempotency, ledger append
            ├── webhooks.index.ts  # router assembly
            └── webhooks.test.ts   # vitest suite
```

## Testing

`npm test` runs 24 tests (3 files) against the shared Postgres test database, non-destructively (per-run `RUN_ID` prefixes + scoped cleanup):

- Webhooks: signature matrix, replay protection, payload validation, exactly-once, concurrent duplicate deliveries.
- Reconciliation engine: parsing/validation, all four classification buckets, deduplication.
- Reconciliation CLI (end-to-end): spawns the real CLI, asserts the summary output and compensating inserts, proves re-run idempotency, and validates the missing-file error path.

## Submission checklist

- [x] Complete Task 1 API code with HMAC signature verification and idempotency.
- [x] Complete Task 2 CLI tool supporting optional path arguments and compensating writes.
- [x] Included `schema.sql` with indexes and unique constraints.
- [x] Included sample `provider_transactions.json` test fixture.
- [x] Completed `README.md` containing setup commands, Task 3 EXPLAIN analysis, and Task 4 critique.
