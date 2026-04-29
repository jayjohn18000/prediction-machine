#!/usr/bin/env node
/**
 * One-shot: cancel stale leaked mm_orders rows stuck in pending (NULL kalshi_order_id).
 * Scoped to mm_market_config.enabled = true — leaves pre-clock/disabled-market clusters untouched (e.g. market_id 265444).
 *
 * Run AFTER Fly redeploy picks up orchestrator pending-reaper + place-failure terminal status.
 */

import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

import { createPgClient } from "../../lib/mm/order-store.mjs";
import { reapStalePendingMmOrders } from "../../lib/mm/pending-order-reaper.mjs";

async function main() {
  const client = createPgClient();
  await client.connect();
  try {
    const { count } = await reapStalePendingMmOrders(client);
    console.log(JSON.stringify({ ok: true, reapCount: count }));
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error("[mm:reap-stuck-pending]", err);
  process.exit(1);
});
