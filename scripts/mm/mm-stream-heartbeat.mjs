#!/usr/bin/env node
/**
 * MM 7-day-test stream heartbeat.
 *
 * Verifies that the data stream the W6 exit criteria depend on is actually
 * flowing. For each enabled mm_market_config row in the last 24h:
 *   - mm_orders activity   (≥1 new order placed)
 *   - provider_market_depth (≥100 rows with non-empty yes_levels)
 *   - mm_pnl_snapshots     (≥100 rows — cron-driven, ~288/day if 5-min interval)
 *
 * Exit code 0 = threshold met; 1 = below threshold (so cron can react).
 *
 * Env:
 *   DATABASE_URL                  — required
 *   MM_HEARTBEAT_MIN_QUOTING      — default 6 (markets that must show orders+depth+pnl)
 */

import "dotenv/config";
import { createPgClient } from "../../lib/mm/order-store.mjs";

const MIN_QUOTING = Number.parseInt(process.env.MM_HEARTBEAT_MIN_QUOTING ?? "6", 10);

export async function runHeartbeat(opts = {}) {
  const ownsClient = opts.client == null;
  /** @type {import('pg').Client} */
  const client = opts.client ?? createPgClient();
  if (ownsClient) await /** @type {any} */ (client).connect();

  try {
    const r = await client.query(
      `
      SELECT
        pm.provider_market_ref AS ticker,
        mc.market_id,
        mc.kill_switch_active,
        (SELECT COUNT(*) FROM pmci.mm_orders o
           WHERE o.market_id = mc.market_id AND o.placed_at > now() - interval '24 hours') AS new_orders_24h,
        (SELECT COUNT(*) FROM pmci.mm_orders o
           WHERE o.market_id = mc.market_id AND o.placed_at > now() - interval '24 hours' AND o.status = 'open') AS new_open_24h,
        (SELECT COUNT(*) FROM pmci.provider_market_depth d
           WHERE d.provider_market_id = mc.market_id AND d.observed_at > now() - interval '24 hours' AND jsonb_array_length(d.yes_levels) > 0) AS depth_with_yes_24h,
        (SELECT COUNT(*) FROM pmci.mm_pnl_snapshots s
           WHERE s.market_id = mc.market_id AND s.observed_at > now() - interval '24 hours') AS pnl_snapshots_24h,
        (SELECT MAX(o.placed_at) FROM pmci.mm_orders o
           WHERE o.market_id = mc.market_id) AS latest_order
      FROM pmci.mm_market_config mc
      JOIN pmci.provider_markets pm ON pm.id = mc.market_id
      WHERE mc.enabled = true
      ORDER BY pm.provider_market_ref
      `,
    );
    const rows = r.rows ?? [];
    const perMarket = rows.map((row) => ({
      ticker: String(row.ticker),
      market_id: Number(row.market_id),
      kill_switch_active: row.kill_switch_active === true,
      new_orders_24h: Number(row.new_orders_24h),
      new_open_24h: Number(row.new_open_24h),
      depth_with_yes_24h: Number(row.depth_with_yes_24h),
      pnl_snapshots_24h: Number(row.pnl_snapshots_24h),
      latest_order: row.latest_order,
      meets_quoting_threshold:
        Number(row.new_orders_24h) >= 1 &&
        Number(row.depth_with_yes_24h) >= 100 &&
        Number(row.pnl_snapshots_24h) >= 100,
    }));

    const quotingCount = perMarket.filter((m) => m.meets_quoting_threshold).length;
    const enabledCount = perMarket.length;
    const ok = quotingCount >= MIN_QUOTING;

    return {
      ok,
      threshold_min_quoting: MIN_QUOTING,
      enabled_markets: enabledCount,
      quoting_markets: quotingCount,
      observed_at: new Date().toISOString(),
      per_market: perMarket,
    };
  } finally {
    if (ownsClient) await /** @type {any} */ (client).end().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHeartbeat()
    .then((summary) => {
      console.log(JSON.stringify(summary));
      process.exit(summary.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error("[mm-stream-heartbeat]", err);
      process.exit(1);
    });
}
