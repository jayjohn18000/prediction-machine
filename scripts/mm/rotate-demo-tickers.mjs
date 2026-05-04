#!/usr/bin/env node
/**
 * MM ticker rotator. Two modes:
 *
 *   MM_RUN_MODE=demo (default) — Kalshi DEMO; legacy 7-day-test behavior.
 *   MM_RUN_MODE=prod          — PROD Kalshi; live capital. ADR-011 spec.
 *
 * Each daily run:
 *   1. Pulls open markets from the appropriate Kalshi REST endpoint
 *   2. Picks the top N (DEMO=8, PROD=10) by liquidity × category × urgency × spread score
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
 *   MM_ROTATOR_TARGET_COUNT        — default 8 (demo) / 10 (prod)
 *   MM_ROTATOR_MIN_CLOSE_HOURS     — default 48 (demo) / 4 (prod)
 *   MM_ROTATOR_RESTART_URL         — runtime restart endpoint (default https://pmci-mm-runtime.fly.dev/admin/restart)
 *   PMCI_ADMIN_KEY                 — admin key for the restart call (skipped if unset)
 *   MM_ROTATOR_DRY_RUN             — '1' | true: enumerate selected/rejected/disabled, perform NO writes
 *   MM_ROTATOR_MARKET_PAGES        — max REST pagination pages for /markets (default 25, ~25k rows cap)
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

/** @param {RunMode} mode */
export function resolveRestBase(mode) {
  return mode === "prod" ? PROD_REST_BASE : DEMO_REST_BASE;
}

/** @param {RunMode} mode */
export function getTargetCountForMode(mode) {
  return Number.parseInt(
    process.env.MM_ROTATOR_TARGET_COUNT ?? (mode === "prod" ? "10" : "8"),
    10,
  );
}

/** @param {RunMode} mode */
export function getMinCloseHoursForMode(mode) {
  return Number.parseFloat(
    process.env.MM_ROTATOR_MIN_CLOSE_HOURS ?? (mode === "prod" ? "4" : "48"),
  );
}

const REST_BASE = resolveRestBase(RUN_MODE);
const TARGET_COUNT = getTargetCountForMode(RUN_MODE);
const MIN_CLOSE_HOURS = getMinCloseHoursForMode(RUN_MODE);
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

export const CATEGORY_MULTIPLIERS = Object.freeze({
  sports: 1.0,
  crypto: 1.0,
  politics: 0.6,
  economics: 0.0,
  finance: 0.0,
  "finance/macro": 0.0,
  climate: 0.5,
  culture: 0.7,
  mentions: 0.5,
  DEFAULT: 0.4,
});

export const URGENCY_BANDS = Object.freeze([
  { maxHours: 4, mult: 1.5 },
  { maxHours: 24, mult: 1.2 },
  { maxHours: 72, mult: 1.0 },
  { maxHours: 336, mult: 0.7 },
  { maxHours: Number.POSITIVE_INFINITY, mult: 0.3 },
]);

export const SPREAD_BANDS = Object.freeze([
  { maxCents: 1, mult: 0.0 },
  { maxCents: 8, mult: 1.0 },
  { maxCents: 15, mult: 0.8 },
  { maxCents: Number.POSITIVE_INFINITY, mult: 0.4 },
]);

export const MAX_PER_EVENT = 3;
export const MAX_PER_SPORT = 5;

/** @param {string} categoryKey */
export function categoryMultiplier(categoryKey) {
  const k = categoryKey in CATEGORY_MULTIPLIERS ? categoryKey : "DEFAULT";
  return /** @type {number} */ (CATEGORY_MULTIPLIERS[k]);
}

/** @param {number} closeInHours */
export function urgencyMultiplier(closeInHours) {
  for (const b of URGENCY_BANDS) {
    if (closeInHours <= b.maxHours) return b.mult;
  }
  return 0.3;
}

/** @param {number} spreadCents */
export function spreadQuality(spreadCents) {
  for (const b of SPREAD_BANDS) {
    if (spreadCents <= b.maxCents) return b.mult;
  }
  return 0.4;
}

/**
 * Map Kalshi market → category key for CATEGORY_MULTIPLIERS.
 * Prefix order is load-bearing — check specific families before broad tokens.
 * @param {object} market
 */
export function inferRotatorCategoryKey(market) {
  const t = String(market?.ticker ?? "");
  const ev = String(market?.event_ticker ?? "");
  const u = `${t} ${ev}`.toUpperCase();

  if (/\bMIDTERM\b|CONTROLS-|GOVPARTY|^GOV[A-Z]/i.test(u)) return "politics";
  if (/KX.*CPI|CPIMAX|UNEMP/i.test(u)) return "economics";
  if (/\bWTI\b|KXWTI|\bOIL\b/i.test(u)) return "finance";
  if (/KXNBA|\bNBA\b/i.test(u)) return "sports";
  if (/KXMLB|\bMLB\b/i.test(u)) return "sports";
  if (/KXNHL|\bNHL\b/i.test(u)) return "sports";
  if (/KXUFC|\bUFC\b/i.test(u)) return "sports";
  if (/KXPGA|\bPGA\b/i.test(u)) return "sports";
  if (/KXATP|\bATP\b/i.test(u)) return "sports";
  if (/KXIPL|\bIPL\b/i.test(u)) return "sports";
  if (/KXNFL|\bNFL\b/i.test(u)) return "sports";
  if (/KXBTC|KXETH|\bBTC\b|\bETH\b/i.test(u)) return "crypto";

  const apiCat = market?.category;
  if (typeof apiCat === "string") {
    const lc = apiCat.toLowerCase();
    if (lc.includes("sport")) return "sports";
    if (lc.includes("crypto")) return "crypto";
    if (lc.includes("politic")) return "politics";
    if (lc.includes("econ") || lc.includes("inflation") || lc.includes("employ")) return "economics";
    if (lc.includes("financial") || lc.includes("macro")) return "finance/macro";
    if (lc.includes("climate")) return "climate";
    if (lc.includes("culture") || lc.includes("entertain")) return "culture";
    if (lc.includes("mention")) return "mentions";
  }

  return "DEFAULT";
}

/**
 * Bucket for diversification caps — sports split by league; non-sports by category.
 * @param {object} market
 */
export function inferSportDiversificationKey(market) {
  const cat = inferRotatorCategoryKey(market);
  if (cat !== "sports") return cat;
  const u = `${market?.ticker ?? ""} ${market?.event_ticker ?? ""}`.toUpperCase();
  if (/KXNBA|\bNBA\b/i.test(u)) return "sports:nba";
  if (/KXMLB|\bMLB\b/i.test(u)) return "sports:mlb";
  if (/KXNHL|\bNHL\b/i.test(u)) return "sports:nhl";
  if (/KXNFL|\bNFL\b/i.test(u)) return "sports:nfl";
  if (/KXUFC|\bUFC\b/i.test(u)) return "sports:mma";
  if (/KXPGA|\bPGA\b/i.test(u)) return "sports:golf";
  if (/KXATP|\bATP\b/i.test(u)) return "sports:tennis";
  if (/KXIPL|\bIPL\b/i.test(u)) return "sports:cricket";
  return "sports:other";
}

/**
 * @param {object} market
 * @param {number} nowMs
 */
export function computeRotatorScoreFields(market, nowMs) {
  const vol = Number.parseFloat(market?.volume_24h_fp ?? "0") || 0;
  const closeIso = market?.close_time;
  const closeMs = typeof closeIso === "string" ? Date.parse(closeIso) : NaN;
  const closeInHours = Number.isFinite(closeMs) ? (closeMs - nowMs) / (3600 * 1000) : 0;
  const yesBid = Number.parseFloat(market?.yes_bid_dollars ?? "0");
  const yesAsk = Number.parseFloat(market?.yes_ask_dollars ?? "0");
  const spreadCents =
    Number.isFinite(yesBid) && Number.isFinite(yesAsk) && yesAsk > yesBid
      ? Math.round((yesAsk - yesBid) * 100)
      : 0;
  const categoryKey = inferRotatorCategoryKey(market);
  const catM = categoryMultiplier(categoryKey);
  const urgM = urgencyMultiplier(closeInHours);
  const sprM = spreadQuality(spreadCents);
  const score = vol * catM * urgM * sprM;
  return {
    score,
    volume: vol,
    categoryKey,
    catM,
    closeInHours,
    urgM,
    spreadCents,
    sprM,
  };
}

/**
 * @param {Array<{ ticker: string, score: number, raw: object, score_breakdown?: object }>} sortedScored descending score
 * @param {number} target
 */
export function applyDiversificationCap(sortedScored, target) {
  const out = [];
  const perEvent = new Map();
  const perSport = new Map();
  for (const row of sortedScored) {
    if (out.length >= target) break;
    if (!(row.score > 0)) continue;
    const m = row.raw;
    const eventKey = String(m?.event_ticker ?? m?.ticker ?? "").trim() || "(none)";
    const sportKey = inferSportDiversificationKey(m);
    const ec = perEvent.get(eventKey) ?? 0;
    const sc = perSport.get(sportKey) ?? 0;
    if (ec >= MAX_PER_EVENT || sc >= MAX_PER_SPORT) continue;
    out.push(row);
    perEvent.set(eventKey, ec + 1);
    perSport.set(sportKey, sc + 1);
  }
  return out;
}

/**
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @returns {Promise<Set<string>>}
 */
export async function fetchActiveBlocklist(client) {
  const r = await client.query(
    `SELECT ticker FROM pmci.mm_ticker_blocklist WHERE expires_at > now()`,
  );
  return new Set(r.rows.map((/** @type {{ ticker: string }} */ row) => String(row.ticker)));
}

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
 * Pure: pick the top N markets by score, then apply mandatory diversification caps.
 * Score = volume_24h × category × urgency(close) × spreadQuality(bid/ask width).
 *
 * @param {Array<object>} markets raw market objects from the Kalshi REST endpoint
 * @param {{
 *   nowMs?: number,
 *   target?: number,
 *   minCloseHours?: number,
 *   logger?: object,
 *   skipProdCrossCheck?: boolean,
 *   fetch?: typeof fetch,
 *   runMode?: RunMode,
 *   blockedTickers?: Set<string>,
 * }} [opts]
 * @returns {Promise<{ selections: Array<{ ticker: string, score: number, raw: object, score_breakdown: object }>, rejected: Array<{ ticker: string, reason: string|undefined }> }>}
 */
export async function selectMarketsForRotation(markets, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const target = opts.target ?? TARGET_COUNT;
  const minCloseHours = opts.minCloseHours ?? MIN_CLOSE_HOURS;
  const minCloseMs = nowMs + minCloseHours * 3600 * 1000;
  const runMode = opts.runMode ?? RUN_MODE;
  const blocked =
    opts.blockedTickers instanceof Set ? opts.blockedTickers : new Set();

  /** @type {Array<{ ticker: string, score: number, raw: object, score_breakdown: object }>} */
  const scored = [];
  /** @type {Array<{ ticker: string, reason: string | undefined }>} */
  const rejected = [];
  for (const m of Array.isArray(markets) ? markets : []) {
    const ticker = String(m?.ticker ?? "");
    if (!ticker) continue;
    if (blocked.has(ticker)) {
      rejected.push({ ticker, reason: "blocklist" });
      continue;
    }
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
      runMode,
    });
    if (!validation.ok) {
      rejected.push({ ticker, reason: validation.reason });
      continue;
    }

    const breakdown = computeRotatorScoreFields(m, nowMs);
    scored.push({
      ticker,
      score: breakdown.score,
      raw: m,
      score_breakdown: breakdown,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));
  const selections = applyDiversificationCap(scored, target);
  return { selections, rejected };
}

async function fetchOpenMarkets(restBase, logger = console) {
  const base = `${restBase.replace(/\/$/, "")}/markets`;
  const maxPages = Number.parseInt(process.env.MM_ROTATOR_MARKET_PAGES ?? "25", 10);
  /** @type {object[]} */
  const all = [];
  /** @type {string | null} */
  let cursor = null;
  let page = 0;
  do {
    const qs = new URLSearchParams({ status: "open", limit: "1000" });
    if (cursor) qs.set("cursor", cursor);
    const url = `${base}?${qs}`;
    const r = await fetch(url);
    if (!r.ok) {
      throw new Error(`fetch markets failed: ${r.status} ${await r.text().catch(() => "")}`);
    }
    const j = await r.json();
    const markets = Array.isArray(j?.markets) ? j.markets : [];
    all.push(...markets);
    const next = j?.cursor;
    cursor = typeof next === "string" && next.trim() ? next : null;
    page += 1;
  } while (cursor && page < maxPages);

  logger.info?.(`[rotator] fetched ${all.length} open markets from ${base} (${page} page(s), cap=${maxPages})`);
  return all;
}

/**
 * INSERT-OR-UPDATE pmci.provider_markets for a Kalshi market and return its bigint id.
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {{ticker: string, raw: object}} sel
 * @param {string} [linkRestBase] Kalshi REST root for permalink (matches run mode)
 * @returns {Promise<number>} provider_markets.id
 */
async function ensureProviderMarketRow(client, sel, linkRestBase = DEMO_REST_BASE) {
  const m = sel.raw;
  const closeIso = typeof m?.close_time === "string" ? m.close_time : null;
  const openIso = typeof m?.open_time === "string" ? m.open_time : null;
  const title = (m?.title ?? sel.ticker).toString().slice(0, 500);
  const status = (m?.status ?? "active").toString();
  const eventRef = (m?.event_ticker ?? null) && String(m.event_ticker);
  const url = m?.market_id ? `${linkRestBase.replace(/\/$/, "")}/markets/${sel.ticker}` : null;
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
 * @param {{ expectedPriceCents?: number|null, runMode?: RunMode }} [opts]
 */
async function upsertMmMarketConfig(client, marketId, opts = {}) {
  const expectedPriceCents = opts.expectedPriceCents ?? null;
  const mode = opts.runMode ?? RUN_MODE;
  const hardPos = deriveHardPositionLimit(mode, expectedPriceCents);
  const mmParams = mode === "prod" ? DEFAULT_MM_PARAMS_PROD : DEFAULT_MM_PARAMS_DEMO;
  const softPos = mode === "prod" ? Math.max(1, Math.floor(hardPos / 4)) : mmParams.soft_position_limit;

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
  const notes = `rotator-managed mode=${mode} hard_pos=${hardPos}@${expectedPriceCents ?? "null"}c expected; refreshed daily by scripts/mm/rotate-demo-tickers.mjs`;
  await client.query(sql, [
    marketId,
    softPos,
    hardPos,
    mmParams.min_half_spread_cents,
    mmParams.base_size_contracts,
    mmParams.k_vol,
    mmParams.max_order_notional_cents,
    mmParams.min_requote_cents,
    mmParams.stale_quote_timeout_seconds,
    mmParams.daily_loss_limit_cents,
    mmParams.inventory_skew_cents,
    mmParams.toxicity_threshold,
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
 * @param {{
 *   client?: import('pg').Client,
 *   logger?: object,
 *   dryRun?: boolean,
 *   runMode?: RunMode,
 *   blockedTickers?: Set<string>,
 * }} [opts]
 */
export async function runRotation(opts = {}) {
  const logger = opts.logger ?? console;
  const dryRun = opts.dryRun ?? DRY_RUN;
  const effectiveMode = opts.runMode ?? RUN_MODE;
  const targetCount = getTargetCountForMode(effectiveMode);
  const minCloseH = getMinCloseHoursForMode(effectiveMode);
  const restBase = resolveRestBase(effectiveMode);
  const ownsClient = opts.client == null && !dryRun;
  /** @type {import('pg').Client | null} */
  const client = dryRun ? null : (opts.client ?? createPgClient());
  if (ownsClient && client) await /** @type {any} */ (client).connect();

  const summary = {
    ok: true,
    mode: effectiveMode,
    dry_run: dryRun,
    started_at: new Date().toISOString(),
    target_count: targetCount,
    rest_base: restBase,
    fetched: 0,
    selected: /** @type {Array<{ticker:string, market_id:number|null, score:number, score_breakdown?: object, expected_price_cents:number|null, hard_pos:number}>} */ ([]),
    rejected: /** @type {Array<{ticker:string, reason?: string}>} */ ([]),
    disabled_count: 0,
    runtime_restart: /** @type {any} */ (null),
    finished_at: /** @type {string|null} */ (null),
    error: /** @type {string|null} */ (null),
  };

  logger.info?.(
    `[rotator] mode=${effectiveMode} dry_run=${dryRun} rest_base=${restBase} target=${targetCount} min_close_hours=${minCloseH}`,
  );

  try {
    let blocked = opts.blockedTickers instanceof Set ? opts.blockedTickers : null;
    if (!blocked && client) {
      try {
        blocked = await fetchActiveBlocklist(client);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn?.(`[rotator] blocklist fetch failed (${msg}) — continuing with empty blocklist`);
        blocked = new Set();
      }
    }
    if (!blocked) blocked = new Set();

    const markets = await fetchOpenMarkets(restBase, logger);
    summary.fetched = markets.length;

    const { selections, rejected } = await selectMarketsForRotation(markets, {
      logger,
      runMode: effectiveMode,
      target: targetCount,
      minCloseHours: minCloseH,
      blockedTickers: blocked,
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
      const hardPos = deriveHardPositionLimit(effectiveMode, expectedPriceCents);
      const bd = sel.score_breakdown;

      if (dryRun) {
        summary.selected.push({
          ticker: sel.ticker,
          market_id: null,
          score: sel.score,
          score_breakdown: bd,
          expected_price_cents: expectedPriceCents,
          hard_pos: hardPos,
        });
        logger.info?.(
          `[rotator-dryrun] would-enable ticker=${sel.ticker} score=${sel.score.toFixed(4)} vol=${bd?.volume} cat=${bd?.categoryKey}×${bd?.catM} urg×${bd?.urgM} spr×${bd?.sprM} expected_price=${expectedPriceCents}c hard_pos=${hardPos}`,
        );
        continue;
      }

      const marketId = await ensureProviderMarketRow(
        /** @type {any} */ (client),
        sel,
        restBase,
      );
      await upsertMmMarketConfig(/** @type {any} */ (client), marketId, {
        expectedPriceCents,
        runMode: effectiveMode,
      });
      keepMarketIds.push(marketId);
      summary.selected.push({
        ticker: sel.ticker,
        market_id: marketId,
        score: sel.score,
        score_breakdown: bd,
        expected_price_cents: expectedPriceCents,
        hard_pos: hardPos,
      });
      logger.info?.(
        `[rotator] enabled ticker=${sel.ticker} market_id=${marketId} score=${sel.score.toFixed(4)} expected_price=${expectedPriceCents}c hard_pos=${hardPos}`,
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
