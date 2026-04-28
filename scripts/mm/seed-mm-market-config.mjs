#!/usr/bin/env node
/**
 * Insert / upsert one DEMO `mm_market_config` row by Kalshi ticker — W3 smoke.
 * Env: DATABASE_URL, MM_SEED_TICKER (or first entry in KALSHI_DEMO_UNIVERSE_TICKERS).
 */

import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

import pg from "pg";

async function main() {
  const ticker =
    process.env.MM_SEED_TICKER?.trim() ||
    process.env.KALSHI_DEMO_UNIVERSE_TICKERS?.split(",")[0]?.trim();
  if (!ticker) {
    console.error("Set MM_SEED_TICKER or comma KALSHI_DEMO_UNIVERSE_TICKERS first.");
    process.exit(1);
  }

  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes("supabase.co") || url.includes("amazonaws") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  const r = await client.query(
    `
    SELECT pm.id
    FROM pmci.provider_markets pm
    JOIN pmci.providers pr ON pr.id = pm.provider_id AND pr.code = 'kalshi'
    WHERE pm.provider_market_ref = $1
    LIMIT 1
    `,
    [ticker],
  );
  const marketId = r.rows[0]?.id;
  if (!marketId) {
    console.error("No pmci.provider_markets row for Kalshi ticker:", ticker);
    process.exit(1);
  }

  await client.query(
    `
    INSERT INTO pmci.mm_market_config (
      market_id, enabled, soft_position_limit, hard_position_limit, min_half_spread_cents,
      base_size_contracts, k_vol, kill_switch_active, notes,
      max_order_notional_cents, min_requote_cents, stale_quote_timeout_seconds, daily_loss_limit_cents
    ) VALUES (
      $1, true, 5, 20, 2,
      1, 1.0, false, 'W3 DEMO seed script',
      5000, 2, 600, 500000
    )
    ON CONFLICT (market_id) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      soft_position_limit = EXCLUDED.soft_position_limit,
      hard_position_limit = EXCLUDED.hard_position_limit,
      min_half_spread_cents = EXCLUDED.min_half_spread_cents,
      base_size_contracts = EXCLUDED.base_size_contracts,
      k_vol = EXCLUDED.k_vol,
      notes = EXCLUDED.notes,
      max_order_notional_cents = EXCLUDED.max_order_notional_cents,
      min_requote_cents = EXCLUDED.min_requote_cents,
      stale_quote_timeout_seconds = EXCLUDED.stale_quote_timeout_seconds,
      daily_loss_limit_cents = EXCLUDED.daily_loss_limit_cents
    `,
    [marketId],
  );

  console.log(`[mm:seed] upserted mm_market_config market_id=${marketId} ticker=${ticker}`);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
