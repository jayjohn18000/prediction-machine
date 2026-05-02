#!/usr/bin/env node
/**
 * MM ticker rotator. Two modes:
 *
 *   MM_RUN_MODE=demo (default) — Kalshi DEMO; legacy 7-day-test behavior.
 *   MM_RUN_MODE=prod          — PROD Kalshi; live capital. ADR-011 spec.
 *
 * Each daily run:
 *   1. Pulls open markets from the appropriate Kalshi REST endpoint
 *   2. Picks the top N (DEMO=8, PROD=2) by volume + close-time score
 *   3. Inserts any new tickers into pmci.provider_markets
 *   4. Upserts pmci.mm_market_config rows with mode-appropriate risk params
 *      (enabled=true, kill_switch=false)
 *   5. Disables prior mm_market_config rows that aren't in today's selection
 *   6. Hits /admin/restart on pmci-mm-runtime so the depth WS re-subscribes
 *
 * Idempotent: rerunning yields the same DB state as long as the Kalshi market set is unchanged.
 *
 * Env:
 *   MM_RUN_MODE                    — 'demo' (default) | 'prod'
 *   DATABASE_URL                   — required
 *   KALSHI_DEMO_REST_BASE          — defaults to https://demo-api.kalshi.co/trade-api/v2 (demo mode)
 *   KALSHI_PROD_REST_BASE          — defaults to https://api.elections.kalshi.com/trade-api/v2 (prod mode)
 *   MM_ROTATOR_TARGET_COUNT        — default 8 (demo) / 2 (prod)
 *   MM_ROTATOR_MIN_CLOSE_HOURS     — default 48 (demo) / 720 (prod ≥30 days per ADR-011)
 *   MM_ROTATOR_RESTART_URL         — runtime restart endpoint (default https://pmci-mm-runtime.fly.dev/admin/restart)
 *   PMCI_ADMIN_KEY                 — admin key for the restart call (skipped if unset)
 *   MM_ROTATOR_DRY_RUN             — '1' | true: enumerate selected/rejected/disabled, perform NO writes
 *
 * CLI flags (override env): --dry-run, --mode=prod|demo
 */

import "dotenv/config";
import { createPgClient } from "../../lib/mm/order-store.mjs";

/** @typedef {'demo' | 'prod'} RunMode */

function parseCliArgs(argv) {
  const args = { dryRun: false, mode: /** @type {RunMode | null} */ (null) };
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--mode=prod") args.mode = "prod";
    else if (a === "--mode=demo") args.mode = "demo";
  }
  return args;
}

const CLI_ARGS = parseCliArgs(process.argv.slice(2));

/** @returns {RunMode} */
function resolveRunMode() {
  if (CLI_ARGS.mode) return CLI_ARGS.mode;
  const envMode = process.env.MM_RUN_MODE?.trim().toLowerCase();
  return envMode === "prod" ? "prod" : "demo";
}

/** @returns {boolean} */
function resolveDryRun() {
  if (CLI_ARGS.dryRun) return true;
  const v = process.env.MM_ROTATOR_DRY_RUN?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

const RUN_MODE = resolveRunMode();
const DRY_RUN = resolveDryRun();

const DEMO_REST_BASE =
  process.env.KALSHI_DEMO_REST_BASE?.trim() ||
  process.env.KALSHI_BASE?.trim() ||
  "https://demo-api.kalshi.co/trade-api/v2";

const PROD_REST_BASE =
  process.env.KALSHI_PROD_REST_BASE?.trim() ||
  "https://api.elections.kalshi.com/trade-api/v2";

const REST_BASE = RUN_MODE === "prod" ? PROD_REST_BASE : DEMO_REST_BASE;

const TARGET_COUNT = Number.parseInt(
  process.env.MM_ROTATOR_TARGET_COUNT ?? (RUN_MODE === "prod" ? "2" : "8"),
  10,
);
const MIN_CLOSE_HOURS = Number.parseFloat(
  process.env.MM_ROTATOR_MIN_CLOSE_HOURS ?? (RUN_MODE === "prod" ? "720" : "48"),
);
const RESTART_URL =
  process.env.MM_ROTATOR_RESTART_URL?.trim() || "https://pmci-mm-runtime.fly.dev/admin/restart";

/**
 * Default risk params per ADR-008 / pre-ADR-011 (DEMO).
 * The day-2 storm tripped at exactly daily_loss_limit_cents=2000.
 */
const DEFAULT_MM_PARAMS_DEMO = Object.freeze({
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
 * Default risk params for live capital per ADR-011 (amended 2026-05-02).
 * Position cap tightened from $50 → $30 notional per operator decision before
 * first-flip; everything else unchanged from ADR-011.
 *
 * `hard_position_limit` here is a FLOOR — the actual upsert clamps it
 * by max(5, min(60, floor(3000 / expected_price_cents))) for a
 * $30 notional cap.
 */
const DEFAULT_MM_PARAMS_PROD = Object.freeze({
  soft_position_limit: 5,
  hard_position_limit: 12, // re-derived at upsert; this is the floor
  min_half_spread_cents: 2,
  base_size_contracts: 1,
  k_vol: 1.0,
  max_order_notional_cents: 500,
  min_requote_cents: 1,
  stale_quote_timeout_seconds: 300,
  daily_loss_limit_cents: 500,
  inventory_skew_cents: 0,
  toxicity_threshold: 200,
});

export const DEFAULT_MM_PARAMS =
  RUN_MODE === "prod" ? DEFAULT_MM_PARAMS_PROD : DEFAULT_MM_PARAMS_DEMO;

const PROD_KALSHI_MARKET_URL = "https://api.elections.kalshi.com/trade-api/v2/markets";

/**
 * Parse Kalshi *_dollars field to number or null when absent.
 * @param {unknown} v
 */
function parseDollarField(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Mid-price when bid and ask are both present.
 * @param {number|null} bid
 * @param {number|null} ask
 */
function yesMidFromSides(bid, ask) {
  if (bid == null || ask == null) return null;
  return (bid + ask) / 2;
}

/**
 * Pre-enable checks for MM rotation (runs after coarse REST filters).
 *
 * In PROD mode, the cross-check error paths (network/HTTP/JSON) flip from
 * "best-effort skip" (`{ ok: true }`) to "required pass"
 * (`{ ok: false, reason: "prod_cross_check_unavailable" }`). Audit lane 17
 * 2026-05-02 flagged the fail-OPEN behavior as cutover-blocking.
 *
 * `skipProdCrossCheck` skips the prod API call — use in unit tests to avoid outbound HTTP.
 *
 * @param {object} market raw Kalshi market from DEMO REST (or PROD when MM_RUN_MODE=prod)
 * @param {{
 *   nowMs?: number,
 *   logger?: { warn?: (msg: string) => void },
 *   skipProdCrossCheck?: boolean,
 *   fetch?: typeof fetch,
 *   runMode?: RunMode,
 * }} [opts]
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function validateTickerForMM(market, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const logger = opts.logger ?? console;
  const skipProdCrossCheck = opts.skipProdCrossCheck === true;
  const runMode = opts.runMode ?? RUN_MODE;
  // In PROD mode, the cross-check is REQUIRED-PASS: any error condition
  // (network, HTTP non-2xx, JSON parse) returns { ok: false } not { ok: true }.
  const crossCheckRequired = runMode === "prod";

  const yesBid = Number.parseFloat(market?.yes_bid_dollars ?? "0");
  const yesAsk = Number.parseFloat(market?.yes_ask_dollars ?? "0");

  const volFp = Number.parseFloat(market?.volume_24h_fp ?? "0") || 0;
  const bidCents = Math.round(yesBid * 100);
  const askCents = Math.round(yesAsk * 100);
  const spreadCentsOrLess = Number.isFinite(bidCents) && Number.isFinite(askCents) && askCents - bidCents <= 1;
  if (spreadCentsOrLess && volFp < 100) {
    return { ok: false, reason: "locked_and_thin" };
  }

  const openIso = market?.open_time;
  if (typeof openIso === "string") {
    const openMs = Date.parse(openIso);
    if (
      Number.isFinite(openMs) &&
      openMs > nowMs &&
      openMs - nowMs > 12 * 3600 * 1000
    ) {
      return { ok: false, reason: "pre_event_dead_air" };
    }
  }

  if (skipProdCrossCheck) return { ok: true };

  const ticker = String(market?.ticker ?? "");
  const fetchFn = opts.fetch ?? globalThis.fetch;

  /** @type {Response | undefined} */
  let res;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2000);
    try {
      res = await fetchFn(`${PROD_KALSHI_MARKET_URL}/${encodeURIComponent(ticker)}`, {
        signal: ac.signal,
      });
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (crossCheckRequired) {
      logger.warn?.(`[rotator] prod market fetch failed ${ticker}: ${msg} — REJECTING (prod-mode required-pass)`);
      return { ok: false, reason: "prod_cross_check_unavailable" };
    }
    logger.warn?.(`[rotator] prod market fetch failed ${ticker}: ${msg} — continuing (demo-mode best-effort)`);
    return { ok: true };
  }

  if (!res.ok) {
    if (crossCheckRequired) {
      logger.warn?.(`[rotator] prod market fetch HTTP ${res.status} for ${ticker} — REJECTING (prod-mode required-pass)`);
      return { ok: false, reason: "prod_cross_check_unavailable" };
    }
    logger.warn?.(`[rotator] prod market fetch HTTP ${res.status} for ${ticker} — continuing (demo-mode best-effort)`);
    return { ok: true };
  }

  let prodBody;
  try {
    prodBody = await res.json();
  } catch {
    if (crossCheckRequired) {
      logger.warn?.(`[rotator] prod market JSON parse failed for ${ticker} — REJECTING (prod-mode required-pass)`);
      return { ok: false, reason: "prod_cross_check_unavailable" };
    }
    logger.warn?.(`[rotator] prod market JSON parse failed for ${ticker} — continuing (demo-mode best-effort)`);
    return { ok: true };
  }

  const prodM = prodBody?.market ?? prodBody;

  const demoBidNullable = parseDollarField(market?.yes_bid_dollars);
  const prodBidNullable = parseDollarField(prodM?.yes_bid_dollars);

  if (prodBidNullable == null && demoBidNullable != null) {
    return { ok: false, reason: "demo_only_book" };
  }

  const demoMid = yesMidFromSides(
    parseDollarField(market?.yes_bid_dollars),
    parseDollarField(market?.yes_ask_dollars),
  );
  const prodMid = yesMidFromSides(
    parseDollarField(prodM?.yes_bid_dollars),
    parseDollarField(prodM?.yes_ask_dollars),
  );

  if (demoMid != null && prodMid != null && Math.abs(demoMid - prodMid) > 0.05) {
    return { ok: false, reason: "demo_prod_divergence" };
  }

  return { ok: true };
}

/**
 * Pure: pick the top N markets by score.
 * Score = volume_24h + (close_in_days * 5). Filters out wide spreads and near-close markets.
 *
 * @param {Array<object>} markets raw market objects from the Kalshi REST endpoint
 * @param {{nowMs?: number, target?: number, minCloseHours?: number, logger?: object, skipProdCrossCheck?: boolean, fetch?: typeof fetch}} [opts]
 * @returns {Promise<{ selections: Array<{ ticker: string, score: number, raw: object }>, rejected: Array<{ ticker: string, reason: string|undefined }> }>}
 */
export async function selectMarketsForRotation(markets, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const target = opts.target ?? TARGET_COUNT;
  const minCloseHours = opts.minCloseHours ?? MIN_CLOSE_HOURS;
  const minCloseMs = nowMs + minCloseHours * 3600 * 1000;

  /** @type {Array<{ ticker: string, score: number, raw: object }>} */
  const scored = [];
  /** @type {Array<{ ticker: string, reason: string | undefined }>} */
  const rejected = [];
  for (const m of Array.isArray(markets) ? markets : []) {
    const ticker = String(m?.ticker ?? "");
    if (!ticker) continue;
    if (ticker.startsWith("KXMVE")) continue; // multi-event combos — exotic, skip
    // Empirically (2026-04-30) Kalshi DEMO returns HTTP 400 invalid_parameters on every
    // post-only order against `KXHIGH*-B*` (below-threshold) markets, regardless of price.
    // The same code path works on the matching `-T*` (above) markets. Until the demo accepts
    // these, exclude B-strike markets from rotation so we get clean two-sided fills.
    if (/-B\d/.test(ticker)) continue;
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

    const validation = await validateTickerForMM(m, {
      nowMs,
      logger: opts.logger,
      skipProdCrossCheck: opts.skipProdCrossCheck === true,
      fetch: opts.fetch,
    });
    if (!validation.ok) {
      rejected.push({ ticker, reason: validation.reason });
      continue;
    }

    const vol = Number.parseFloat(m?.volume_24h_fp ?? "0") || 0;
    const closeDays = (closeMs - nowMs) / (24 * 3600 * 1000);
    const score = vol + closeDays * 5;
    scored.push({ ticker, score, raw: m });
  }
  scored.sort((a, b) => b.score - a.score);
  return { selections: scored.slice(0, target), rejected };
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
 * Derive a $50-notional-bounded `hard_position_limit` (contracts) from a fill-time
 * expected price. Used in PROD mode per ADR-011: caps notional at $50 regardless
 * of market price. In DEMO mode this returns the static DEFAULT_MM_PARAMS_DEMO value.
 *
 * @param {RunMode} mode
 * @param {number|null} expectedPriceCents
 */
export function deriveHardPositionLimit(mode, expectedPriceCents) {
  if (mode !== "prod") return DEFAULT_MM_PARAMS_DEMO.hard_position_limit;
  if (
    expectedPriceCents == null ||
    !Number.isFinite(expectedPriceCents) ||
    expectedPriceCents <= 0
  ) {
    // Conservative fallback when price unknown
    return 5;
  }
  // ADR-011 amended 2026-05-02: $30 notional ceiling (was $50).
  // $30 / price-in-cents = contracts. Floor 5, ceiling 60.
  const raw = Math.floor(3000 / expectedPriceCents);
  return Math.max(5, Math.min(60, raw));
}

/**
 * Upsert a row in pmci.mm_market_config with mode-appropriate MM risk params, enabled=true.
 *
 * In PROD mode (ADR-011): hard_position_limit is fill-price-derived from the $50
 * notional cap; soft = floor(hard / 4); the rest come from DEFAULT_MM_PARAMS_PROD.
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {number} marketId
 * @param {{ expectedPriceCents?: number|null }} [opts]
 */
async function upsertMmMarketConfig(client, marketId, opts = {}) {
  const expectedPriceCents = opts.expectedPriceCents ?? null;
  const hardPos = deriveHardPositionLimit(RUN_MODE, expectedPriceCents);
  const softPos = RUN_MODE === "prod" ? Math.max(1, Math.floor(hardPos / 4)) : DEFAULT_MM_PARAMS.soft_position_limit;

  const sql = `
    INSERT INTO pmci.mm_market_config (
      market_id, enabled, soft_position_limit, hard_position_limit,
      min_half_spread_cents, base_size_contracts, k_vol, kill_switch_active,
      max_order_notional_cents, min_requote_cents, stale_quote_timeout_seconds,
      daily_loss_limit_cents, inventory_skew_cents, toxicity_threshold,
      notes
    ) VALUES (
      $1::bigint, true, $2, $3, $4, $5, $6, false, $7, $8, $9, $10, $11, $12,
      $13
    )
    ON CONFLICT (market_id) DO UPDATE SET
      enabled = true,
      kill_switch_active = false,
      soft_position_limit = EXCLUDED.soft_position_limit,
      hard_position_limit = EXCLUDED.hard_position_limit,
      min_half_spread_cents = EXCLUDED.min_half_spread_cents,
      max_order_notional_cents = EXCLUDED.max_order_notional_cents,
      stale_quote_timeout_seconds = EXCLUDED.stale_quote_timeout_seconds,
      daily_loss_limit_cents = EXCLUDED.daily_loss_limit_cents,
      toxicity_threshold = EXCLUDED.toxicity_threshold,
      notes = COALESCE(pmci.mm_market_config.notes, '') ||
              ' | rotator-refreshed ' || to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
  `;
  const notes = `rotator-managed mode=${RUN_MODE} hard_pos=${hardPos}@${expectedPriceCents ?? "null"}c expected; refreshed daily by scripts/mm/rotate-demo-tickers.mjs`;
  await client.query(sql, [
    marketId,
    softPos,
    hardPos,
    DEFAULT_MM_PARAMS.min_half_spread_cents,
    DEFAULT_MM_PARAMS.base_size_contracts,
    DEFAULT_MM_PARAMS.k_vol,
    DEFAULT_MM_PARAMS.max_order_notional_cents,
    DEFAULT_MM_PARAMS.min_requote_cents,
    DEFAULT_MM_PARAMS.stale_quote_timeout_seconds,
    DEFAULT_MM_PARAMS.daily_loss_limit_cents,
    DEFAULT_MM_PARAMS.inventory_skew_cents,
    DEFAULT_MM_PARAMS.toxicity_threshold,
    notes,
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

function logRotatorRejectionSummary(logger, rejected) {
  if (rejected.length === 0) {
    logger.info?.("[rotator] rejected 0 candidates");
    return;
  }
  const byReason = new Map();
  for (const { reason } of rejected) {
    const key = reason ?? "unknown";
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  const rejectionsByReason = [...byReason.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  logger.info?.(`[rotator] rejected ${rejected.length} candidates: ${rejectionsByReason}`);
}

/**
 * Main rotator entry point. Returns a summary object — used as both the script
 * exit JSON and the in-process API response.
 *
 * Honors `MM_ROTATOR_DRY_RUN` / `--dry-run`: enumerates selected/rejected/disabled
 * without writing to provider_markets, mm_market_config, or POSTing /admin/restart.
 *
 * @param {{client?: import('pg').Client, logger?: object, dryRun?: boolean}} [opts]
 */
export async function runRotation(opts = {}) {
  const logger = opts.logger ?? console;
  const dryRun = opts.dryRun ?? DRY_RUN;
  const ownsClient = opts.client == null && !dryRun;
  /** @type {import('pg').Client | null} */
  const client = dryRun ? null : (opts.client ?? createPgClient());
  if (ownsClient && client) await /** @type {any} */ (client).connect();

  const summary = {
    ok: true,
    mode: RUN_MODE,
    dry_run: dryRun,
    started_at: new Date().toISOString(),
    target_count: TARGET_COUNT,
    rest_base: REST_BASE,
    fetched: 0,
    selected: /** @type {Array<{ticker:string, market_id:number|null, score:number, expected_price_cents:number|null, hard_pos:number}>} */ ([]),
    rejected: /** @type {Array<{ticker:string, reason?: string}>} */ ([]),
    disabled_count: 0,
    runtime_restart: /** @type {any} */ (null),
    finished_at: /** @type {string|null} */ (null),
    error: /** @type {string|null} */ (null),
  };

  logger.info?.(`[rotator] mode=${RUN_MODE} dry_run=${dryRun} rest_base=${REST_BASE} target=${TARGET_COUNT} min_close_hours=${MIN_CLOSE_HOURS}`);

  try {
    const markets = await fetchOpenMarkets(REST_BASE, logger);
    summary.fetched = markets.length;

    const { selections, rejected } = await selectMarketsForRotation(markets, {
      logger,
      runMode: RUN_MODE,
    });
    summary.rejected = rejected;

    if (selections.length === 0) {
      summary.ok = false;
      summary.error = "no_markets_matched_selection";
      logger.error?.("[rotator] no markets matched the selection criteria — aborting rotation");
      logRotatorRejectionSummary(logger, summary.rejected);
      return summary;
    }

    /** @type {number[]} */
    const keepMarketIds = [];
    for (const sel of selections) {
      const expectedPriceCents = computeExpectedPriceCents(sel.raw);
      const hardPos = deriveHardPositionLimit(RUN_MODE, expectedPriceCents);

      if (dryRun) {
        summary.selected.push({
          ticker: sel.ticker,
          market_id: null,
          score: sel.score,
          expected_price_cents: expectedPriceCents,
          hard_pos: hardPos,
        });
        logger.info?.(
          `[rotator-dryrun] would-enable ticker=${sel.ticker} score=${sel.score.toFixed(2)} expected_price=${expectedPriceCents}c hard_pos=${hardPos}`,
        );
        continue;
      }

      const marketId = await ensureProviderMarketRow(/** @type {any} */ (client), sel);
      await upsertMmMarketConfig(/** @type {any} */ (client), marketId, { expectedPriceCents });
      keepMarketIds.push(marketId);
      summary.selected.push({
        ticker: sel.ticker,
        market_id: marketId,
        score: sel.score,
        expected_price_cents: expectedPriceCents,
        hard_pos: hardPos,
      });
      logger.info?.(
        `[rotator] enabled ticker=${sel.ticker} market_id=${marketId} score=${sel.score.toFixed(2)} expected_price=${expectedPriceCents}c hard_pos=${hardPos}`,
      );
    }

    if (dryRun) {
      logger.info?.("[rotator-dryrun] skipping disableStaleMmMarketConfig + runtime_restart");
      summary.disabled_count = 0;
      summary.runtime_restart = { ok: false, skipped: "dry_run" };
    } else if (client) {
      summary.disabled_count = await disableStaleMmMarketConfig(client, keepMarketIds);
      logger.info?.(`[rotator] disabled ${summary.disabled_count} prior mm_market_config rows`);
      summary.runtime_restart = await triggerRuntimeRestart(logger);
    }

    logRotatorRejectionSummary(logger, summary.rejected);
  } catch (err) {
    summary.ok = false;
    summary.error = err instanceof Error ? err.message : String(err);
    logger.error?.("[rotator] error", err);
  } finally {
    if (ownsClient && client) await /** @type {any} */ (client).end().catch(() => {});
  }

  summary.finished_at = new Date().toISOString();
  return summary;
}

/**
 * Compute an expected fill price for a Kalshi market in integer cents,
 * preferring the YES mid when both sides are present, else `last_price`.
 * Returns `null` if no signal is available.
 *
 * @param {object} m raw Kalshi market
 * @returns {number|null}
 */
export function computeExpectedPriceCents(m) {
  const yb = parseDollarField(m?.yes_bid_dollars);
  const ya = parseDollarField(m?.yes_ask_dollars);
  if (yb != null && ya != null && ya > yb) {
    return Math.round(((yb + ya) / 2) * 100);
  }
  const last = parseDollarField(m?.last_price_dollars);
  if (last != null) return Math.round(last * 100);
  return null;
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
