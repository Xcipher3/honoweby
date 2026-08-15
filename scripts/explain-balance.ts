import process from 'node:process'

import { sql } from 'drizzle-orm'

import db, { pool } from '@/db'

function BALANCE_QUERY(email: string) {
  return sql`
  SELECT SUM(amount_cents)
  FROM ledger_entries
  WHERE customer_email = ${email}
    AND status = 'completed'
`
}

async function main(): Promise<void> {
  const [idx] = (await db.execute(sql`
    SELECT indexdef
    FROM pg_indexes
    WHERE tablename = 'ledger_entries' AND indexname = 'ledger_customer_status_idx'
  `)).rows
  console.log(`Covering index:\n${String(idx?.indexdef)}`)

  const [counts] = (await db.execute(sql`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'completed')::int AS completed
    FROM ledger_entries
  `)).rows
  console.log(`\nLedger: ${counts.total} rows total, ${counts.completed} completed`)

  const [heavy] = (await db.execute(sql`
    SELECT count(*)::int AS n
    FROM ledger_entries
    WHERE customer_email = 'heavy@example.com' AND status = 'completed'
  `)).rows
  console.log(`heavy@example.com completed rows: ${heavy.n}`)

  console.log('\n--- EXPLAIN (ANALYZE, BUFFERS) | exact spec query (user@example.com, 0 rows) ---')
  const specPlan = await db.execute(sql`
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT SUM(amount_cents)
    FROM ledger_entries
    WHERE customer_email = 'user@example.com'
      AND status = 'completed'
  `)
  for (const r of specPlan.rows) {
    console.log(String(r['QUERY PLAN']))
  }

  console.log('\n--- EXPLAIN (ANALYZE, BUFFERS) | 15,000-row customer (heavy@example.com) ---')
  const heavyPlan = await db.execute(sql`
    EXPLAIN (ANALYZE, BUFFERS)
    ${BALANCE_QUERY('heavy@example.com')}
  `)
  for (const r of heavyPlan.rows) {
    console.log(String(r['QUERY PLAN']))
  }

  console.log('\n--- EXPLAIN (ANALYZE, BUFFERS) | index-only scan forced (enable_seqscan=off) ---')
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_seqscan = off`)
    const forcedPlan = await tx.execute(sql`
      EXPLAIN (ANALYZE, BUFFERS)
      ${BALANCE_QUERY('heavy@example.com')}
    `)
    for (const r of forcedPlan.rows) {
      console.log(String(r['QUERY PLAN']))
    }
  })
}

await main().catch((err: unknown) => {
  console.error(`explain-balance: ${String(err)}`)
  process.exitCode = 1
}).finally(async () => {
  await pool.end()
})
