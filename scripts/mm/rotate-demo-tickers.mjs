#!/usr/bin/env node
/**
 * MM 7-day-test daily ticker rotator.
 *
 * Designed for Kalshi DEMO, where active books are short-dated and a static ticker
 * list cannot survive a 7-day window. Each day this script:
 *   1. Pulls open markets from demo-api.kalshi.co
 *   2. Picks the top N (default 8) by volume + close-time score
 *   3. Inserts any new tickers into pmci.provider_markets
 *   4. Upserts pmci.mm_market_config rows with standard MM risk params (enabled=true, kill_switch=false)
 *   5. Disables prior mm_market_config rows that aren't in today's selection
 *   6. (best-effort) Hits /admin/restart on pmci-mm-runtime so the depth WS re-subscribes
 *
 * Idempotent: rerunning yields the same DB state as long as the Kalshi market set is unchanged.
 *
 * Env:
 *   DATABASE_URL                   — required
 *   KALSHI_DEMO_REST_BASE          — defaults to https://demo-api.kalshi.co/trade-api/v2
 *   MM_ROTATOR_TARGET_COUNT        — default 8
 *   MM_ROTATOR_MIN_CLOSE_HOURS     — default 24 (skip markets closing sooner than this)
 *   MM_ROTATOR_RESTART_URL         — runtime restart endpoint (default https://pmci-mm-runtime.fly.dev/admin/restart)
 *   PMCI_ADMIN_KEY                 — admin key for the restart call (skipped if unset)
 */

import "dotenv/config";
import { createPgClient } from "../../lib/mm/order-store.mjs";

const DEMO_REST_BASE =
  process.env.KALSHI_DEMO_REST_BASE?.trim() ||
  process.env.KALSHI_BASE?.trim() ||
  "https://demo-api.kalshi.co/trade-api/v2";

const TARGET_COUNT = Number.parseInt(process.env.MM_ROTATOR_TARGET_COUNT ?? "8", 10);
const MIN_CLOSE_HOURS = Number.parseFloat(process.env.MM_ROTATOR_MIN_CLOSE_HOURS ?? "24");
const RESTART_URL =
  process.env.MM_ROTATOR_RESTART_URL?.trim() || "https://pmci-mm-runtime.fly.dev/admin/restart";

/** Default risk params for newly-rotated MM markets (matches existing mm_market_config rows). */
const DEFAULT_MM_PARAMS = Object.freeze({
  soft_position_limit: 5,
  hard_position_limit: 20,
  min_half_spread_cents: 1,
  base_size_contracts: 1,
  k_vol: 1.0,
  max_order_notional_cents: 1000,
  min_requote_cents: 1,
  stale_quote_timeout_seconds: 600,
  daily_loss_limit_cents: 2000,
  inventory_skew_cents: 0,
  toxicity_threshold: 500,
});

/**
 * Pure: pick the top N markets by score.
 * Score = volume_24h + (close_in_days * 5). Filters out wide spreads and near-close markets.
 *
 * @param {Array<object>} markets raw market objects from the Kalshi REST endpoint
 * @param {{nowMs?: number, target?: number, minCloseHours?: number}} [opts]
 */
export function selectMarketsForRotation(markets, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const target = opts.target ?? TARGET_COUNT;
  const minCloseHours = opts.minCloseHours ?? MIN_CLOSE_HOURS;
  const minCloseMs = nowMs + minCloseHours * 3600 * 1000;

  /** @type {Array<{ ticker: string, score: number, raw: object }>} */
  const scored = [];
  for (const m of Array.isArray(markets) ? markets : []) {
    const ticker = String(m?.ticker ?? "");
    if (!ticker) continue;
    if (ticker.startsWith("KXMVE")) continue; // multi-event combos — exotic, skip
    const yesBid = Number.parseFloat(m?.yes_bid_dollars ?? "0");
    const yesAsk = Number.parseFloat(m?.yes_ask_dollars ?? "0");
    if (!Number.isFinite(yesBid) || !Number.isFinite(yesAsk)) continue;
    if (yesBid <= 0.01 || yesAsk <= 0.01) continue;
    if (yesAsk <= yesBid) continue;
    // ask=1.00 on Kalshi means "no real ask in the book" (max-price seller). Skip — the MM
    // would have to set the ask itself with no anchor, which inflates risk on demo.
    if (yesAsk >= 0.99) continue;
    const closeIso = m?.close_time;
    if (typeof closeIso !== "string") continue;
    const closeMs = Date.parse(closeIso);
    if (!Number.isFinite(closeMs) || closeMs < minCloseMs) continue;
    const vol = Number.parseFloat(m?.volume_24h_fp ?? "0") || 0;
    const closeDays = (closeMs - nowMs) / (24 * 3600 * 1000);
    const score = vol + closeDays * 5;
    scored.push({ ticker, score, raw: m });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, target);
}

async function fetchOpenMarkets(restBase, logger = console) {
  const url = `${restBase.replace(/\/$/, "")}/markets?status=open&limit=1000`;
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`fetch markets failed: ${r.status} ${await r.text().catch(() => "")}`);
  }
  const j = await r.json();
  const markets = Array.isArray(j?.markets) ? j.markets : [];
  logger.info?.(`[rotator] fetched ${markets.length} open markets from ${url}`);
  return markets;
}

/**
 * INSERT-OR-UPDATE pmci.provider_markets for a Kalshi market and return its bigint id.
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {{ticker: string, raw: object}} sel
 * @returns {Promise<number>} provider_markets.id
 */
async function ensureProviderMarketRow(client, sel) {
  const m = sel.raw;
  const closeIso = typeof m?.close_time === "string" ? m.close_time : null;
  const openIso = typeof m?.open_time === "string" ? m.open_time : null;
  const title = (m?.title ?? sel.ticker).toString().slice(0, 500);
  const status = (m?.status ?? "active").toString();
  const eventRef = (m?.event_ticker ?? null) && String(m.event_ticker);
  const url = m?.market_id ? `${DEMO_REST_BASE.replace(/\/$/, "")}/markets/${sel.ticker}` : null;
  const metadata = {
    rotator_source: "kalshi-demo",
    rotator_inserted_at: new Date().toISOString(),
    yes_bid_dollars: m?.yes_bid_dollars ?? null,
    yes_ask_dollars: m?.yes_ask_dollars ?? null,
    volume_24h_fp: m?.volume_24h_fp ?? null,
  };

  const sql = `
    INSERT INTO pmci.provider_markets
      (provider_id, provider_market_ref, event_ref, title, category, url,
       open_time, close_time, status, metadata, last_seen_at)
    VALUES (
      (SELECT id FROM pmci.providers WHERE code='kalshi' LIMIT 1),
      $1, $2, $3, 'mm-rotator', $4, $5::timestamptz, $6::timestamptz, $7, $8::jsonb, now()
    )
    ON CONFLICT (provider_id, provider_market_ref) DO UPDATE SET
      title = EXCLUDED.title,
      close_time = EXCLUDED.close_time,
      status = EXCLUDED.status,
      last_seen_at = now(),
      metadata = pmci.provider_markets.metadata || EXCLUDED.metadata
    RETURNING id
  `;
  const r = await client.query(sql, [
    sel.ticker,
    eventRef,
    title,
    url,
    openIso,
    closeIso,
    status,
    JSON.stringify(metadata),
  ]);
  return Number(r.rows[0].id);
}

/**
 * Upsert a row in pmci.mm_market_config with standard MM risk params, enabled=true.
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {number} marketId
 */
async function upsertMmMarketConfig(client, marketId) {
  const sql = `
    INSERT INTO pmci.mm_market_config (
      market_id, enabled, soft_position_limit, hard_position_limit,
      min_half_spread_cents, base_size_contracts, k_vol, kill_switch_active,
      max_order_notional_cents, min_requote_cents, stale_quote_timeout_seconds,
      daily_loss_limit_cents, inventory_skew_cents, toxicity_threshold,
      notes
    ) VALUES (
      $1::bigint, true, $2, $3, $4, $5, $6, false, $7, $8, $9, $10, $11, $12,
      'rotator-managed: refreshed daily by scripts/mm/rotate-demo-tickers.mjs'
    )
    ON CONFLICT (market_id) DO UPDATE SET
      enabled = true,
      kill_switch_active = false,
      notes = COALESCE(pmci.mm_market_config.notes, '') ||
              ' | rotator-refreshed ' || to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
  `;
  await client.query(sql, [
    marketId,
    DEFAULT_MM_PARAMS.soft_position_limit,
    DEFAULT_MM_PARAMS.hard_position_limit,
    DEFAULT_MM_PARAMS.min_half_spread_cents,
    DEFAULT_MM_PARAMS.base_size_contracts,
    DEFAULT_MM_PARAMS.k_vol,
    DEFAULT_MM_PARAMS.max_order_notional_cents,
    DEFAULT_MM_PARAMS.min_requote_cents,
    DEFAULT_MM_PARAMS.stale_quote_timeout_seconds,
    DEFAULT_MM_PARAMS.daily_loss_limit_cents,
    DEFAULT_MM_PARAMS.inventory_skew_cents,
    DEFAULT_MM_PARAMS.toxicity_threshold,
  ]);
}

/**
 * Disable mm_market_config rows that aren't in `keepMarketIds`.
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {number[]} keepMarketIds
 * @returns {Promise<number>} count of rows disabled
 */
async function disableStaleMmMarketConfig(client, keepMarketIds) {
  if (!keepMarketIds.length) return 0;
  const r = await client.query(
    `UPDATE pmci.mm_market_config
     SET enabled = false
     WHERE enabled = true AND NOT (market_id = ANY($1::bigint[]))
     RETURNING market_id`,
    [keepMarketIds],
  );
  return r.rowCount ?? 0;
}

async function triggerRuntimeRestart(logger = console) {
  const adminKey = process.env.PMCI_ADMIN_KEY?.trim();
  if (!adminKey) {
    logger.warn?.("[rotator] PMCI_ADMIN_KEY unset — skipping runtime restart");
    return { ok: false, reason: "no_admin_key" };
  }
  try {
    const r = await fetch(RESTART_URL, {
      method: "POST",
      headers: { "x-pmci-admin-key": adminKey },
    });
    const body = await r.text().catch(() => "");
    logger.info?.(`[rotator] runtime restart status=${r.status} body=${body.slice(0, 200)}`);
    return { ok: r.ok, status: r.status };
  } catch (e) {
    logger.error?.(`[rotator] runtime restart failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, error: String(e) };
  }
}

/**
 * Main rotator entry point. Returns a summary object — used as both the script
 * exit JSON and the in-process API response.
 *
 * @param {{client?: import('pg').Client, logger?: object}} [opts]
 */
export async function runRotation(opts = {}) {
  const logger = opts.logger ?? console;
  const ownsClient = opts.client == null;
  /** @type {import('pg').Client} */
  const client = opts.client ?? createPgClient();
  if (ownsClient) await /** @type {any} */ (client).connect();

  const summary = {
    ok: true,
    started_at: new Date().toISOString(),
    target_count: TARGET_COUNT,
    fetched: 0,
    selected: /** @type {Array<{ticker:string, market_id:number, score:number}>} */ ([]),
    disabled_count: 0,
    runtime_restart: /** @type {any} */ (null),
    finished_at: /** @type {string|null} */ (null),
    error: /** @type {string|null} */ (null),
  };

  try {
    const markets = await fetchOpenMarkets(DEMO_REST_BASE, logger);
    summary.fetched = markets.length;

    const selections = selectMarketsForRotation(markets);
    if (selections.length === 0) {
      summary.ok = false;
      summary.error = "no_markets_matched_selection";
      logger.error?.("[rotator] no markets matched the selection criteria — aborting rotation");
      return summary;
    }

    /** @type {number[]} */
    const keepMarketIds = [];
    for (const sel of selections) {
      const marketId = await ensureProviderMarketRow(client, sel);
      await upsertMmMarketConfig(client, marketId);
      keepMarketIds.push(marketId);
      summary.selected.push({ ticker: sel.ticker, market_id: marketId, score: sel.score });
      logger.info?.(`[rotator] enabled ticker=${sel.ticker} market_id=${marketId} score=${sel.score.toFixed(2)}`);
    }

    summary.disabled_count = await disableStaleMmMarketConfig(client, keepMarketIds);
    logger.info?.(`[rotator] disabled ${summary.disabled_count} prior mm_market_config rows`);

    summary.runtime_restart = await triggerRuntimeRestart(logger);
  } catch (err) {
    summary.ok = false;
    summary.error = err instanceof Error ? err.message : String(err);
    logger.error?.("[rotator] error", err);
  } finally {
    if (ownsClient) await /** @type {any} */ (client).end().catch(() => {});
  }

  summary.finished_at = new Date().toISOString();
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRotation()
    .then((summary) => {
      console.log(JSON.stringify(summary));
      process.exit(summary.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error("[rotate-demo-tickers]", err);
      process.exit(1);
    });
}
