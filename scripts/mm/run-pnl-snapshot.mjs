#!/usr/bin/env node
/**
 * Writes Contract R7 rows into pmci.mm_pnl_snapshots for every enabled MM market.
 * Invoked by fly admin job `mm-pnl-snapshot` / pg_cron every 5 minutes.
 */

import { createPgClient } from "../../lib/mm/order-store.mjs";
import { insertPnlSnapshotsAllEnabledMarkets } from "../../lib/mm/pnl-attribution.mjs";

async function main() {
  const client = createPgClient();
  await client.connect();
  try {
    const out = await insertPnlSnapshotsAllEnabledMarkets(client);
    console.log(JSON.stringify({ ok: true, ...out }));
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error("[mm-pnl-snapshot]", err);
  process.exit(1);
});
