#!/usr/bin/env node
/**
 * One-shot backfill: set mm_orders.status = 'filled' for any row that has mm_fills
 * but is not yet marked filled. Operator runs after deploy (service-role DATABASE_URL).
 *
 *   node scripts/mm/backfill-status-from-fills.mjs
 */

import { loadEnv } from "../../src/platform/env.mjs";
import { createPgClient, syncMmOrderFillStateFromFills } from "../../lib/mm/order-store.mjs";

loadEnv();

async function main() {
  const client = createPgClient();
  await client.connect();
  try {
    const ids = await client.query(`
      SELECT DISTINCT order_id
      FROM pmci.mm_fills
      WHERE order_id IS NOT NULL
    `);
    let n = 0;
    for (const row of ids.rows) {
      await syncMmOrderFillStateFromFills(client, row.order_id);
      n += 1;
    }
    console.error(`[backfill-status-from-fills] synced ${n} parent order row(s) from mm_fills`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
