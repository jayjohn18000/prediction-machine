#!/usr/bin/env node
/**
 * MM 7-day-test stream heartbeat.
 *
 * Threshold semantics: per-hour rates rather than 24h totals, so the alarm
 * doesn't false-fire for the first day after a daily ticker rotation.
 *
 * For each enabled mm_market_config row, "quoting" requires:
 *   - has currently-open orders on Kalshi (≥1 with status='open') — counts existing resting
 *     orders, not just new placements, because the MM correctly leaves a quote in place when
 *     the book hasn't moved (no min_requote_cents trigger).
 *   - provider_market_depth (≥120 rows with non-empty yes_levels in window — 1Hz emitter ⇒
 *     3600/hr expected, 120 = 3.3% of expected, generous tolerance)
 *   - mm_pnl_snapshots     (≥6 rows in window — 5-min cron ⇒ 12/hr expected, 6 = 50% tolerance)
 *
 * Exit code 0 = ≥MM_HEARTBEAT_MIN_QUOTING markets meeting the threshold; 1 otherwise.
 *
 * Env:
 *   DATABASE_URL                  — required
 *   MM_HEARTBEAT_MIN_QUOTING      — default 6
 *   MM_HEARTBEAT_WINDOW_MIN       — default 60 (minutes lookback)
 *   MM_HEARTBEAT_MIN_DEPTH        — default 120 (depth rows in window)
 *   MM_HEARTBEAT_MIN_PNL          — default 6 (pnl_snapshots in window)
 */

import "dotenv/config";
import { createPgClient } from "../../lib/mm/order-store.mjs";

const MIN_QUOTING = Number.parseInt(process.env.MM_HEARTBEAT_MIN_QUOTING ?? "6", 10);
const WINDOW_MIN = Number.parseInt(process.env.MM_HEARTBEAT_WINDOW_MIN ?? "60", 10);
const MIN_DEPTH = Number.parseInt(process.env.MM_HEARTBEAT_MIN_DEPTH ?? "120", 10);
const MIN_PNL = Number.parseInt(process.env.MM_HEARTBEAT_MIN_PNL ?? "6", 10);

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
           WHERE o.market_id = mc.market_id
             AND o.placed_at > now() - ($1::int * INTERVAL '1 minute')) AS new_orders_window,
        (SELECT COUNT(*) FROM pmci.mm_orders o
           WHERE o.market_id = mc.market_id
             AND o.status = 'open') AS currently_open_orders,
        (SELECT COUNT(*) FROM pmci.provider_market_depth d
           WHERE d.provider_market_id = mc.market_id
             AND d.observed_at > now() - ($1::int * INTERVAL '1 minute')
             AND jsonb_array_length(d.yes_levels) > 0) AS depth_with_yes_window,
        (SELECT COUNT(*) FROM pmci.mm_pnl_snapshots s
           WHERE s.market_id = mc.market_id
             AND s.observed_at > now() - ($1::int * INTERVAL '1 minute')) AS pnl_snapshots_window,
        (SELECT MAX(o.placed_at) FROM pmci.mm_orders o
           WHERE o.market_id = mc.market_id) AS latest_order
      FROM pmci.mm_market_config mc
      JOIN pmci.provider_markets pm ON pm.id = mc.market_id
      WHERE mc.enabled = true
      ORDER BY pm.provider_market_ref
      `,
      [WINDOW_MIN],
    );
    const rows = r.rows ?? [];
    const perMarket = rows.map((row) => {
      const newOrders = Number(row.new_orders_window);
      const currentlyOpen = Number(row.currently_open_orders);
      const depth = Number(row.depth_with_yes_window);
      const pnl = Number(row.pnl_snapshots_window);
      return {
        ticker: String(row.ticker),
        market_id: Number(row.market_id),
        kill_switch_active: row.kill_switch_active === true,
        new_orders_window: newOrders,
        currently_open_orders: currentlyOpen,
        depth_with_yes_window: depth,
        pnl_snapshots_window: pnl,
        latest_order: row.latest_order,
        meets_quoting_threshold:
          currentlyOpen >= 1 && depth >= MIN_DEPTH && pnl >= MIN_PNL,
      };
    });

    const quotingCount = perMarket.filter((m) => m.meets_quoting_threshold).length;
    const enabledCount = perMarket.length;
    const ok = quotingCount >= MIN_QUOTING;

    return {
      ok,
      window_minutes: WINDOW_MIN,
      threshold_min_quoting: MIN_QUOTING,
      threshold_min_depth_per_window: MIN_DEPTH,
      threshold_min_pnl_per_window: MIN_PNL,
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
