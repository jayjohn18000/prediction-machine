#!/usr/bin/env node
/**
 * Post-W6 D — insert 5 hand-picked DEMO-tradeable Kalshi markets into pmci.provider_markets
 * and enable pmci.mm_market_config (ADR-008). Tickers validated against demo-api.kalshi.co.
 *
 * Env: DATABASE_URL (service role URI)
 */
import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

import pg from "pg";

/** Curated DEMO markets: mixed economics + esports + sports; books verified ~2026-04-28 */
const ROWS = [
  {
    ticker: "KXPAYROLLS-26APR-T40000",
    title: "Will above 40000 jobs be added in April 2026?",
    category: "economics",
  },
  {
    ticker: "KXDOTA2MAP-26APR260400FLCAUR-2-AUR",
    title: "Will Aurora win map 2 in the Team Falcons vs. Aurora match?",
    category: "esports",
  },
  {
    ticker: "KXNHLSERIESGAMES-26PHIPITR1-7",
    title:
      "Will there be over 6.5 total games in the Philadelphia Flyers vs Pittsburgh Penguins 1st Round series in the 2026 NHL playoffs?",
    category: "sports_nhl",
  },
  {
    ticker: "KXPGATOUR-PGC26-TFLE",
    title: "Will Tommy Fleetwood win the PGA Championship?",
    category: "sports_golf",
  },
  {
    ticker: "KXNBATOTAL-26APR28ATLNYK-229",
    title: "Game 5: Atlanta at New York: Total Points",
    category: "sports_nba",
  },
];

const MM_DEFAULTS = {
  soft_position_limit: 5,
  hard_position_limit: 20,
  max_order_notional_cents: 5000,
  min_requote_cents: 1,
  min_half_spread_cents: 2,
  stale_quote_timeout_seconds: 30,
  daily_loss_limit_cents: 2000,
  base_size_contracts: 1,
  k_vol: 1.0,
  inventory_skew_cents: 15,
  toxicity_threshold: 500,
  kill_switch_active: false,
};

async function main() {
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

  const pr = await client.query(`SELECT id FROM pmci.providers WHERE code = 'kalshi' LIMIT 1`);
  const providerId = pr.rows[0]?.id;
  if (providerId == null) {
    console.error("pmci.providers has no kalshi row");
    process.exit(1);
  }

  await client.query("BEGIN");

  const marketIds = [];

  for (const row of ROWS) {
    let closeTime = null;
    try {
      const r = await fetch(`https://demo-api.kalshi.co/trade-api/v2/markets/${encodeURIComponent(row.ticker)}`);
      const j = await r.json();
      const close = j?.market?.close_time ?? j?.close_time;
      if (close) closeTime = close;
    } catch {
      console.warn(`[seed] could not fetch DEMO close_time for ${row.ticker}`);
    }
    if (!closeTime) {
      console.warn(`[seed] close_time unset for ${row.ticker}; INSERT uses NULL`);
    }

    const ins = await client.query(
      `
      INSERT INTO pmci.provider_markets (
        provider_id, provider_market_ref, title, category, status, close_time,
        market_type, first_seen_at, last_seen_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6::timestamptz,
        'binary'::pmci.market_type, now(), now()
      )
      ON CONFLICT (provider_id, provider_market_ref) DO UPDATE SET
        title = EXCLUDED.title,
        category = EXCLUDED.category,
        status = EXCLUDED.status,
        close_time = COALESCE(EXCLUDED.close_time, pmci.provider_markets.close_time),
        last_seen_at = now()
      RETURNING id
      `,
      [providerId, row.ticker, row.title, row.category, "active", closeTime],
    );
    const id = ins.rows[0].id;
    marketIds.push({ ticker: row.ticker, id, category: row.category });
    console.log(`provider_markets id=${id} ticker=${row.ticker}`);
  }

  for (const { id } of marketIds) {
    await client.query(
      `
      INSERT INTO pmci.mm_market_config (
        market_id, enabled, soft_position_limit, hard_position_limit,
        min_half_spread_cents, base_size_contracts, k_vol, kill_switch_active, notes,
        max_order_notional_cents, min_requote_cents, stale_quote_timeout_seconds, daily_loss_limit_cents,
        inventory_skew_cents, toxicity_threshold
      ) VALUES (
        $1, true, $2, $3,
        $4, $5, $6, $7, $8,
        $9, $10, $11, $12,
        $13, $14
      )
      ON CONFLICT (market_id) DO UPDATE SET
        enabled = true,
        soft_position_limit = EXCLUDED.soft_position_limit,
        hard_position_limit = EXCLUDED.hard_position_limit,
        min_half_spread_cents = EXCLUDED.min_half_spread_cents,
        base_size_contracts = EXCLUDED.base_size_contracts,
        k_vol = EXCLUDED.k_vol,
        kill_switch_active = EXCLUDED.kill_switch_active,
        notes = EXCLUDED.notes,
        max_order_notional_cents = EXCLUDED.max_order_notional_cents,
        min_requote_cents = EXCLUDED.min_requote_cents,
        stale_quote_timeout_seconds = EXCLUDED.stale_quote_timeout_seconds,
        daily_loss_limit_cents = EXCLUDED.daily_loss_limit_cents,
        inventory_skew_cents = EXCLUDED.inventory_skew_cents,
        toxicity_threshold = EXCLUDED.toxicity_threshold
      `,
      [
        id,
        MM_DEFAULTS.soft_position_limit,
        MM_DEFAULTS.hard_position_limit,
        MM_DEFAULTS.min_half_spread_cents,
        MM_DEFAULTS.base_size_contracts,
        MM_DEFAULTS.k_vol,
        MM_DEFAULTS.kill_switch_active,
        "ADR-008 Post-W6 D demo Kalshi cohort",
        MM_DEFAULTS.max_order_notional_cents,
        MM_DEFAULTS.min_requote_cents,
        MM_DEFAULTS.stale_quote_timeout_seconds,
        MM_DEFAULTS.daily_loss_limit_cents,
        MM_DEFAULTS.inventory_skew_cents,
        MM_DEFAULTS.toxicity_threshold,
      ],
    );
  }

  const clockRes = await client.query(`SELECT now() AS adr_clock`);
  const adrClock = clockRes.rows[0].adr_clock;

  await client.query("COMMIT");
  await client.end();

  console.log("ADR clock (transaction commit after mm_market_config upserts):", adrClock.toISOString());
  console.log(JSON.stringify({ adr_clock_iso: adrClock.toISOString(), marketIds }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
