/**
 * Sports universe ingestion: Kalshi (by sports series_ticker) + Polymarket (by sports tag_id).
 * Writes to pmci.provider_markets and pmci.provider_market_snapshots.
 * Populates sport, event_type, game_date, home_team, away_team columns added in Phase E1.1.
 *
 * Usage: node lib/ingestion/sports-universe.mjs
 * Or:    npm run pmci:ingest:sports
 */

import {
  createPmciClient,
  getProviderIds,
  ingestProviderMarket,
  addIngestionCounts,
} from "../pmci-ingestion.mjs";
import { parseNum, clamp01 } from "./services/price-parsers.mjs";
import {
  inferSportFromKalshiTicker,
  inferSportFromPolymarketTags,
} from "./services/sport-inference.mjs";

const KALSHI_BASES = [
  "https://api.elections.kalshi.com/trade-api/v2",
  "https://api.kalshi.com/trade-api/v2",
];
const POLYMARKET_BASE = "https://gamma-api.polymarket.com";

// Sports series ticker prefixes to ingest from Kalshi
const KALSHI_SPORTS_PREFIXES = [
  "NFL", "NBA", "MLB", "NHL",
  "NCAAFB", "NCAABB", "NCAAF", "NCAAB",
  "UCL", "EPL", "MLS", "FIFA", "LALIGA",
  "BUNDESLIGA", "SERIEA", "LIGUE1",
  "UFC", "MMA", "TENNIS", "GOLF", "PGA",
  "F1", "FORMULA", "BOXING",
];

// Polymarket sports tag slugs
const POLYMARKET_SPORTS_TAGS = [
  "nfl", "nba", "mlb", "nhl",
  "ncaa", "college-football", "college-basketball",
  "soccer", "ufc", "mma", "tennis", "golf", "formula-1",
  "boxing", "sports",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) {}
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return data;
}

async function fetchKalshiWithRetry(url, { maxRetries = 3, stats } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    for (const base of KALSHI_BASES) {
      try {
        const u = url.replace(KALSHI_BASES[0], base).replace(KALSHI_BASES[1], base);
        return await fetchJson(u);
      } catch (err) {
        if (err.status === 429) {
          if (stats) stats.rate_limited = (stats.rate_limited || 0) + 1;
          await sleep(2000 * (attempt + 1));
        }
        if (attempt === maxRetries) throw err;
      }
    }
    await sleep(500 * attempt);
  }
}

/**
 * Parse game_date from Kalshi event ticker or market close_time.
 * Returns ISO date string (YYYY-MM-DD) or null.
 */
function parseGameDate(closeTime) {
  if (!closeTime) return null;
  try {
    const d = new Date(closeTime);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch { return null; }
}

/**
 * Best-effort home/away extraction from market title.
 * Looks for "X vs Y" or "X at Y" patterns.
 */
function parseTeams(title) {
  if (!title) return { homeTeam: null, awayTeam: null };
  const m = String(title).match(/^(.+?)\s+(?:vs\.?|@|at)\s+(.+?)(?:\s*[:\-\(]|$)/i);
  if (!m) return { homeTeam: null, awayTeam: null };
  const [, away, home] = m;
  return {
    homeTeam: home.trim().slice(0, 100),
    awayTeam: away.trim().slice(0, 100),
  };
}

// ────────────────────────────────────────────────────
// Kalshi sports ingestion
// ────────────────────────────────────────────────────

async function ingestKalshiSports(pmciClient, providerId, observedAt, report) {
  const base = KALSHI_BASES[0];
  const maxRetries = 3;

  // Fetch all series and filter to sports
  let cursor = null;
  const sportSeries = [];
  let page = 0;
  while (true) {
    const url = new URL(`${base}/series`);
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    let data;
    try { data = await fetchKalshiWithRetry(url.toString(), { maxRetries, stats: report }); }
    catch (err) { console.warn("Kalshi /series fetch error:", err.message); break; }
    const series = Array.isArray(data?.series) ? data.series : [];
    for (const s of series) {
      const ticker = String(s?.ticker || "");
      if (KALSHI_SPORTS_PREFIXES.some((p) => ticker.toUpperCase().startsWith(p))) {
        sportSeries.push(ticker);
      }
    }
    cursor = data?.cursor;
    page++;
    if (!cursor || page > 50) break;
    await sleep(200);
  }

  console.log(`[sports-universe] Kalshi: found ${sportSeries.length} sports series`);

  for (const seriesTicker of sportSeries) {
    const sport = inferSportFromKalshiTicker(seriesTicker);
    // Fetch events for this series
    let evCursor = null;
    let evPage = 0;
    while (true) {
      const url = new URL(`${base}/events`);
      url.searchParams.set("series_ticker", seriesTicker);
      url.searchParams.set("limit", "100");
      url.searchParams.set("status", "open");
      if (evCursor) url.searchParams.set("cursor", evCursor);
      let evData;
      try { evData = await fetchKalshiWithRetry(url.toString(), { maxRetries, stats: report }); }
      catch (err) { console.warn(`Kalshi events error for ${seriesTicker}:`, err.message); break; }
      const events = Array.isArray(evData?.events) ? evData.events : [];
      for (const ev of events) {
        const eventTicker = String(ev?.event_ticker || "");
        if (!eventTicker) continue;
        // Fetch markets for this event
        const mUrl = new URL(`${base}/markets`);
        mUrl.searchParams.set("event_ticker", eventTicker);
        mUrl.searchParams.set("limit", "200");
        let mData;
        try { mData = await fetchKalshiWithRetry(mUrl.toString(), { maxRetries, stats: report }); }
        catch (err) { console.warn(`Kalshi markets error for ${eventTicker}:`, err.message); continue; }
        const markets = Array.isArray(mData?.markets) ? mData.markets : [];
        for (const m of markets) {
          const ticker = m?.ticker;
          if (!ticker) continue;
          if (String(m?.status || "").toLowerCase() !== "open") continue;

          const priceYes = clamp01(parseNum(m?.yes_ask_dollars ?? m?.last_price_dollars));
          const title = String(m?.title || m?.subtitle || ticker);
          const { homeTeam, awayTeam } = parseTeams(title);
          const gameDate = parseGameDate(m?.close_time);

          const counts = await ingestProviderMarket(pmciClient, {
            providerId,
            providerMarketRef: String(ticker),
            eventRef: eventTicker,
            title,
            category: "sports",
            url: m?.url ? String(m.url) : null,
            openTime: m?.open_time ?? null,
            closeTime: m?.close_time ?? null,
            status: String(m?.status || ""),
            metadata: { series_ticker: seriesTicker, event_ticker: eventTicker },
            sport,
            eventType: "game_result",
            gameDate,
            homeTeam,
            awayTeam,
            priceYes,
            bestBidYes: parseNum(m?.yes_bid_dollars) ?? null,
            bestAskYes: parseNum(m?.yes_ask_dollars) ?? null,
            raw: m,
          }, observedAt);
          addIngestionCounts(report, counts);
        }
        await sleep(100);
      }
      evCursor = evData?.cursor;
      evPage++;
      if (!evCursor || evPage > 20) break;
      await sleep(200);
    }
    await sleep(300);
  }
}

// ────────────────────────────────────────────────────
// Polymarket sports ingestion
// ────────────────────────────────────────────────────

async function fetchPolymarketTagId(tagSlug) {
  const url = `${POLYMARKET_BASE}/tags?slug=${encodeURIComponent(tagSlug)}&limit=1`;
  try {
    const data = await fetchJson(url);
    const tags = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
    return tags[0]?.id ?? null;
  } catch { return null; }
}

async function ingestPolymarketSports(pmciClient, providerId, observedAt, report) {
  for (const tagSlug of POLYMARKET_SPORTS_TAGS) {
    const tagId = await fetchPolymarketTagId(tagSlug);
    if (!tagId) { console.warn(`[sports-universe] Polymarket: tag not found: ${tagSlug}`); continue; }

    let offset = 0;
    const limit = 100;
    while (true) {
      const url = new URL(`${POLYMARKET_BASE}/markets`);
      url.searchParams.set("tag_id", String(tagId));
      url.searchParams.set("active", "true");
      url.searchParams.set("closed", "false");
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      let data;
      try { data = await fetchJson(url.toString()); }
      catch (err) { console.warn(`Polymarket error for tag ${tagSlug}:`, err.message); break; }
      const markets = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
      if (markets.length === 0) break;

      for (const m of markets) {
        const condId = m?.conditionId || m?.condition_id;
        if (!condId) continue;
        const tagSlugs = (m?.tags || []).map((t) => t?.slug || t);
        const sport = inferSportFromPolymarketTags(tagSlugs);
        const title = String(m?.question || m?.title || condId);
        const { homeTeam, awayTeam } = parseTeams(title);
        const gameDate = parseGameDate(m?.endDate || m?.end_date_iso);

        // Derive best yes price from outcomes
        let priceYes = null;
        const outcomes = m?.outcomes || [];
        const outcomePrices = m?.outcomePrices || [];
        if (outcomes.length === 2) {
          const yesIdx = outcomes.findIndex((o) => String(o).toLowerCase() === "yes");
          if (yesIdx >= 0) priceYes = clamp01(parseNum(outcomePrices[yesIdx]));
        }

        const counts = await ingestProviderMarket(pmciClient, {
          providerId,
          providerMarketRef: String(condId),
          eventRef: m?.slug || null,
          title,
          category: "sports",
          url: m?.url ? String(m.url) : null,
          openTime: m?.startDate || m?.start_date_iso || null,
          closeTime: m?.endDate || m?.end_date_iso || null,
          status: m?.active ? "open" : "closed",
          metadata: { tag_id: tagId, tag_slug: tagSlug, clob_token_ids: m?.clobTokenIds },
          sport,
          eventType: "game_result",
          gameDate,
          homeTeam,
          awayTeam,
          priceYes,
          raw: m,
        }, observedAt);
        addIngestionCounts(report, counts);
      }

      offset += markets.length;
      if (markets.length < limit) break;
      await sleep(300);
    }
    await sleep(500);
  }
}

// ────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────

export async function runSportsUniverse(opts = {}) {
  const { dryRun = false } = opts;
  const report = {
    marketsUpserted: 0,
    snapshotsAppended: 0,
    rate_limited: 0,
    errors: 0,
    startedAt: new Date().toISOString(),
  };

  if (dryRun) {
    console.log("[sports-universe] dry-run: skipping DB writes");
    return report;
  }

  const pmciClient = createPmciClient();
  if (!pmciClient) {
    console.warn("[sports-universe] No DATABASE_URL; skipping PMCI writes");
    return report;
  }
  await pmciClient.connect();

  const providerIds = await getProviderIds(pmciClient);
  if (!providerIds) {
    console.warn("[sports-universe] Could not resolve provider IDs; skipping");
    await pmciClient.end();
    return report;
  }

  const observedAt = new Date().toISOString();

  console.log("[sports-universe] Starting Kalshi sports ingestion…");
  await ingestKalshiSports(pmciClient, providerIds.kalshi, observedAt, report);

  console.log("[sports-universe] Starting Polymarket sports ingestion…");
  await ingestPolymarketSports(pmciClient, providerIds.polymarket, observedAt, report);

  await pmciClient.end();

  report.finishedAt = new Date().toISOString();
  console.log("[sports-universe] Done:", JSON.stringify(report, null, 2));
  return report;
}

// Run directly if this is the entrypoint
if (process.argv[1] && process.argv[1].endsWith("sports-universe.mjs")) {
  runSportsUniverse().catch((err) => {
    console.error("[sports-universe] Fatal:", err);
    process.exit(1);
  });
}
