/**
 * Sports universe ingestion: Kalshi (by sports series_ticker) + Polymarket (by sports tag_id).
 * Writes to pmci.provider_markets and pmci.provider_market_snapshots.
 * Populates sport, event_type, game_date, home_team, away_team columns added in Phase E1.1.
 *
 * Usage: node lib/ingestion/sports-universe.mjs
 * Or:    npm run pmci:ingest:sports
 */

import { existsSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import {
  createPmciClient,
  getProviderIds,
  ingestProviderMarket,
  addIngestionCounts,
  backfillEmbeddings,
} from "../pmci-ingestion.mjs";
import { maybeApplyTemplateAfterIngest } from "../matching/templates/ingest-classify.mjs";
import { retry, fetchWithTimeout } from "../retry.mjs";
import { parseNum, clamp01 } from "./services/price-parsers.mjs";
import {
  inferSportFromKalshiTicker,
  inferSportFromPolymarketTags,
} from "./services/sport-inference.mjs";

// ────────────────────────────────────────────────────
// Concurrency guard — prevents overlapping runs
// ────────────────────────────────────────────────────

const LOCK_FILE = "/tmp/pmci-sports-ingest.lock";

function acquireLock() {
  if (existsSync(LOCK_FILE)) {
    try {
      const existingPid = parseInt(readFileSync(LOCK_FILE, "utf8").trim(), 10);
      process.kill(existingPid, 0); // throws if process is not running
      console.warn(`[sports-universe] Another instance (PID ${existingPid}) is already running. Exiting.`);
      return false;
    } catch {
      // Stale lock — process no longer exists
      console.log("[sports-universe] Removing stale lockfile from previous run.");
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE); } catch { /* already gone */ }
}

// ────────────────────────────────────────────────────
// Non-sport series denylist
// These Kalshi series are tagged as Sports by Kalshi but are not sports markets.
// Skip them entirely to avoid polluting pmci.provider_markets.
// ────────────────────────────────────────────────────

const NON_SPORT_SERIES_DENYLIST = new Set([
  "KXDONATEMRBEAST", // MrBeast NIL donation — not a sport
  "KXSTEPHDEAL",     // Steph Curry endorsement deal — not a game market
]);

const KALSHI_BASES = [
  "https://api.elections.kalshi.com/trade-api/v2",
  "https://api.kalshi.com/trade-api/v2",
];
const POLYMARKET_BASE = "https://gamma-api.polymarket.com";
const MAX_EVENT_PAGES = Number(process.env.PMCI_SPORTS_MAX_EVENT_PAGES ?? '100');

// Kalshi uses category="Sports" for all sports series — the most reliable filter
// Tickers are KX-prefixed (e.g. KXNFLWINS-ATL) so prefix matching doesn't work

// Polymarket sports keyword patterns — matched against tag labels and slugs
const POLYMARKET_SPORTS_PATTERNS = [
  /\bnfl\b/i, /\bnba\b/i, /\bmlb\b/i, /\bnhl\b/i,
  /\bsoccer\b/i, /\bfootball\b/i, /\bbasketball\b/i,
  /\bbaseball\b/i, /\bhockey\b/i,
  /\bchampions.?league\b/i, /\bpremier.?league\b/i,
  /\bworld.?cup\b/i, /\bla.?liga\b/i, /\bbundesliga\b/i,
  /\bserie.?a\b/i, /\bligue\b/i, /\bmls\b/i,
  /\bufc\b/i, /\bmma\b/i, /\btennis\b/i, /\bgolf\b/i,
  /\bpga\b/i, /\bformula.?1\b/i, /\b\bf1\b/i, /\boxing\b/i,
  /\bncaa\b/i, /\bcollege.?football\b/i, /\bcollege.?basketball\b/i,
  /\bnascar\b/i, /\bindycar\b/i, /\bwrestl/i, /\be.?sports\b/i,
  /\bwimbledon\b/i, /\bus.?open\b/i, /\bmasters\b/i,
  /\bsuper.?bowl\b/i, /\bworld.?series\b/i, /\bstanley.?cup\b/i,
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createPacer(baseMs = 50) {
  let delay = baseMs;
  return {
    async pace() { await sleep(delay); delay = baseMs; },
    backoff() { delay = Math.min(delay * 2, 2000); },
  };
}

async function fetchJson(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts, 10_000);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function fetchKalshiWithRetry(url, { maxRetries = 3, stats } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    for (const base of KALSHI_BASES) {
      try {
        const u = url.replace(KALSHI_BASES[0], base).replace(KALSHI_BASES[1], base);
        return await fetchJson(u);
      } catch (err) {
        lastErr = err;
        if (err.status === 429) {
          if (stats) stats.rate_limited = (stats.rate_limited || 0) + 1;
          await sleep(2000 * (attempt + 1));
        }
      }
    }
    if (attempt === maxRetries) throw lastErr;
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
 * Looks for "X vs Y", "X @ Y", or "X at Y" patterns.
 * E1.5 fix: exclude "at least/most/once/all/any/the/a" false positives so that
 * titles like "Will X win at least Y games" no longer extract garbage team names.
 */
function parseTeams(title) {
  if (!title) return { homeTeam: null, awayTeam: null };
  // "at" is only a matchup separator when NOT followed by common qualifier words.
  // Negative lookahead prevents "at least", "at most", "at once", "at all", "at any", "at the", "at a " false matches.
  const m = String(title).match(/^(.+?)\s+(?:vs\.?|@|at(?!\s+(?:least|most|once|all|any|the\b|a\b)))\s+(.+?)(?:\s*[:\-\(]|$)/i);
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
  const collectedIds = [];
  const pacer = createPacer(50);

  let allSeriesData;
  try {
    const url = new URL(`${base}/series`);
    url.searchParams.set("limit", "10000");
    allSeriesData = await fetchKalshiWithRetry(url.toString(), { maxRetries, stats: report });
  } catch (err) {
    console.warn("Kalshi /series fetch error:", err.message);
    return;
  }

  const allSeries = Array.isArray(allSeriesData?.series) ? allSeriesData.series : [];
  // { ticker, title } for each sports series
  const sportSeries = allSeries
    .filter(s => (s?.category || '').toLowerCase() === 'sports')
    .map(s => ({ ticker: String(s.ticker || ''), title: String(s.title || '') }));

  console.log(`[sports-universe] Kalshi: found ${sportSeries.length} sports series (of ${allSeries.length} total)`);

  for (const { ticker: seriesTicker, title: seriesTitle } of sportSeries) {
    // Skip non-sport series that Kalshi mis-categorises under Sports
    if (NON_SPORT_SERIES_DENYLIST.has(seriesTicker)) {
      console.log(`[sports-universe] Skipping denylisted series: ${seriesTicker}`);
      continue;
    }
    // Infer sport from the human-readable series title; fall back to ticker if title produces 'unknown'
    const sport = inferSportFromKalshiTicker(seriesTitle, seriesTicker);
    // Fetch events for this series
    let evCursor = null;
    let evPage = 0;
    while (true) {
      const url = new URL(`${base}/events`);
      url.searchParams.set("series_ticker", seriesTicker);
      url.searchParams.set("limit", "100");
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
          // Kalshi market status is 'active' (not 'open') — skip only clearly settled/closed markets
          const mStatus = String(m?.status || "").toLowerCase();
          if (mStatus && !['active', 'open'].includes(mStatus)) continue;

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
            volume24h: parseNum(m?.volume_24h ?? m?.volume_24h_fp) ?? null,
            raw: m,
          }, observedAt, { skipEmbedding: true });
          addIngestionCounts(report, counts);
          if (counts.providerMarketId) {
            collectedIds.push(counts.providerMarketId);
            await maybeApplyTemplateAfterIngest(pmciClient, {
              id: counts.providerMarketId,
              title,
              provider_market_ref: String(ticker),
              provider_id: providerId,
              category: "sports",
            });
          }
        }
        await pacer.pace();
      }
      evCursor = evData?.cursor;
      evPage++;
      if (!evCursor || evPage > MAX_EVENT_PAGES) break;
      await pacer.pace();
    }
    await pacer.pace();
  }

  if (collectedIds.length > 0) {
    const filled = await backfillEmbeddings(pmciClient, collectedIds);
    console.log(`[sports-universe] Kalshi: backfilled ${filled} embeddings for ${collectedIds.length} markets`);
  }
}

// ────────────────────────────────────────────────────
// Polymarket sports ingestion
// ────────────────────────────────────────────────────

/**
 * E1.4: Fetch sports tag IDs from the dedicated /sports endpoint.
 * This is the authoritative, fast path — one request returns all sport→tag_id mappings.
 * Returns an array of { id, slug, label } objects, or null if the endpoint fails/is empty.
 */
async function fetchPolymarketSportsTagsFromSportsEndpoint() {
  try {
    const url = `${POLYMARKET_BASE}/sports`;
    const data = await fetchJson(url);
    const sports = Array.isArray(data) ? data : [];

    if (sports.length === 0) {
      console.log('[sports-universe] /sports endpoint returned empty; will fall back to tag keyword search');
      return null;
    }

    // Each sport has a comma-separated `tags` field of numeric tag IDs
    const tagMap = new Map(); // tagId -> sportLabel
    for (const s of sports) {
      const sportLabel = String(s.sport || s.slug || s.name || s.sport_id || s.id || '').toLowerCase();
      const rawTags = String(s.tags || '');
      for (const id of rawTags.split(',').map(t => t.trim()).filter(Boolean)) {
        tagMap.set(id, sportLabel);
      }
    }

    const result = [...tagMap.entries()].map(([tagId, sportLabel]) => ({
      id: tagId,
      slug: sportLabel,
      label: sportLabel,
    }));

    console.log(`[sports-universe] /sports endpoint: ${result.length} tag IDs across ${sports.length} sports`);
    return result.length > 0 ? result : null;
  } catch (err) {
    console.warn('[sports-universe] /sports endpoint error:', err.message, '— falling back to tag keyword search');
    return null;
  }
}

/**
 * Fetch all Polymarket tags and return those matching sports keywords.
 * Polymarket has thousands of specific tags (madrid-open, connor-mcdavid, etc.)
 * so we can't hardcode slugs — keyword matching against labels/slugs is required.
 * Used as fallback when /sports endpoint is unavailable.
 */
async function fetchPolymarketSportsTags() {
  // E1.4: try the dedicated /sports endpoint first — authoritative and fast
  const fromSportsEndpoint = await fetchPolymarketSportsTagsFromSportsEndpoint();
  if (fromSportsEndpoint) return fromSportsEndpoint;

  // Fallback: paginate all tags and keyword-filter
  console.log('[sports-universe] Falling back to full tag pagination + keyword filter');
  const allTags = [];
  let offset = 0;
  const limit = 500;
  while (true) {
    try {
      const url = `${POLYMARKET_BASE}/tags?limit=${limit}&offset=${offset}`;
      const data = await fetchJson(url);
      const batch = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
      if (batch.length === 0) break;
      allTags.push(...batch);
      if (batch.length < limit) break;
      offset += batch.length;
      await sleep(200);
    } catch (err) {
      console.warn("[sports-universe] Polymarket tags fetch error:", err.message);
      break;
    }
  }
  const isSports = (t) => POLYMARKET_SPORTS_PATTERNS.some(
    re => re.test(t?.label || '') || re.test(t?.slug || '')
  );
  const matched = allTags.filter(isSports);
  console.log(`[sports-universe] Polymarket: ${matched.length} sports tags found (of ${allTags.length} total)`);
  return matched;
}

async function ingestPolymarketSports(pmciClient, providerId, observedAt, report) {
  const collectedIds = [];
  const pacer = createPacer(50);
  const sportsTags = await fetchPolymarketSportsTags();
  for (const tag of sportsTags) {
    const tagId = tag.id;
    const tagSlug = tag.slug || String(tagId);

    let offset = 0;
    const limit = 100;
    while (true) {
      // E1.4 fix: removed invalid `active=true` param (not a valid Gamma API parameter —
      // causes empty responses). Use `closed=false&archived=false` for live markets.
      const url = new URL(`${POLYMARKET_BASE}/markets`);
      url.searchParams.set("tag_id", String(tagId));
      url.searchParams.set("closed", "false");
      url.searchParams.set("archived", "false");
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
        const title = String(m?.question || m?.title || condId);
        // E1.5 fix: Polymarket tag IDs are often numeric (e.g. "5", "155") which don't match
        // text-based POLYMARKET_TAG_MAP entries → all return 'unknown'. Fall back to title-based
        // inference (same patterns as Kalshi) when tag inference fails.
        let sport = inferSportFromPolymarketTags([
          ...tagSlugs,
          String(tag?.slug || ''),
          String(tag?.label || ''),
        ]);
        if (sport === 'unknown') {
          sport = inferSportFromKalshiTicker(title);
        }
        const { homeTeam, awayTeam } = parseTeams(title);
        const gameDate = parseGameDate(m?.endDate || m?.end_date_iso);

        // E1.4 fix: outcomePrices is a STRINGIFIED JSON array in the Gamma API — must parse.
        // Also derive a consistent 'active' status matching Kalshi convention.
        let priceYes = null;
        const outcomes = m?.outcomes || [];
        let outcomePrices = [];
        try {
          outcomePrices = typeof m?.outcomePrices === 'string'
            ? JSON.parse(m.outcomePrices)
            : (Array.isArray(m?.outcomePrices) ? m.outcomePrices : []);
        } catch { outcomePrices = []; }
        if (outcomes.length === 2) {
          const yesIdx = outcomes.findIndex((o) => String(o).toLowerCase() === "yes");
          if (yesIdx >= 0) priceYes = clamp01(parseNum(outcomePrices[yesIdx]));
        }

        // Parse clobTokenIds (also stringified JSON in Gamma API)
        let clobTokenIds = [];
        try {
          clobTokenIds = typeof m?.clobTokenIds === 'string'
            ? JSON.parse(m.clobTokenIds)
            : (Array.isArray(m?.clobTokenIds) ? m.clobTokenIds : []);
        } catch { clobTokenIds = []; }

        // Status: active=true + closed=false + archived!=true → 'active' (consistent with Kalshi)
        const isLive = m?.active === true && m?.closed === false && m?.archived !== true;

        const polySlug = m?.slug ? String(m.slug) : null;
        const marketId = m?.id != null ? String(m.id) : String(condId);
        const counts = await ingestProviderMarket(pmciClient, {
          providerId,
          providerMarketRef: String(condId),
          eventRef: polySlug,
          title,
          category: "sports",
          url: m?.url ? String(m.url) : null,
          openTime: m?.startDate || m?.start_date_iso || null,
          closeTime: m?.endDate || m?.end_date_iso || null,
          status: isLive ? "active" : "closed",
          metadata: {
            source: "sports-universe",
            provider: "polymarket",
            tag_id: tagId,
            tag_slug: tagSlug,
            market_id: marketId,
            slug: polySlug,
            clob_token_ids: clobTokenIds,
          },
          sport,
          eventType: "game_result",
          gameDate,
          homeTeam,
          awayTeam,
          priceYes,
          bestBidYes: parseNum(m?.bestBid) ?? null,
          bestAskYes: parseNum(m?.bestAsk) ?? null,
          volume24h: parseNum(m?.volume24hr ?? m?.volume_24hr ?? m?.volume_24h) ?? null,
          raw: m,
        }, observedAt, { skipEmbedding: true });
        addIngestionCounts(report, counts);
        if (counts.providerMarketId) {
          collectedIds.push(counts.providerMarketId);
          await maybeApplyTemplateAfterIngest(pmciClient, {
            id: counts.providerMarketId,
            title,
            provider_market_ref: String(condId),
            provider_id: providerId,
            category: "sports",
          });
        }
      }

      offset += markets.length;
      if (markets.length < limit) break;
      await pacer.pace();
    }
    await pacer.pace();
  }

  if (collectedIds.length > 0) {
    const filled = await backfillEmbeddings(pmciClient, collectedIds);
    console.log(`[sports-universe] Polymarket: backfilled ${filled} embeddings for ${collectedIds.length} markets`);
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

  // Concurrency guard — exit immediately if another instance is already running
  if (!acquireLock()) {
    report.skipped = true;
    report.skipReason = "already_running";
    return report;
  }
  // Release lock on any exit path
  process.once("exit", releaseLock);
  process.once("SIGINT", () => { releaseLock(); process.exit(0); });
  process.once("SIGTERM", () => { releaseLock(); process.exit(0); });

  try {
    // ── Kalshi ingestion — uses its own connection ──
    const kalshiClient = createPmciClient();
    if (!kalshiClient) {
      console.warn("[sports-universe] No DATABASE_URL; skipping PMCI writes");
      releaseLock();
      return report;
    }
    await kalshiClient.connect();
    const providerIds = await getProviderIds(kalshiClient);
    if (!providerIds) {
      console.warn("[sports-universe] Could not resolve provider IDs; skipping");
      await kalshiClient.end();
      releaseLock();
      return report;
    }
    const observedAt = new Date().toISOString();
    console.log("[sports-universe] Starting Kalshi sports ingestion…");
    await ingestKalshiSports(kalshiClient, providerIds.kalshi, observedAt, report);
    await kalshiClient.end();
    console.log("[sports-universe] Kalshi ingestion complete. Upserted so far:", report.marketsUpserted);

    // ── Polymarket ingestion — fresh connection avoids timeout from long Kalshi loop ──
    console.log("[sports-universe] Starting Polymarket sports ingestion…");
    const polyClient = createPmciClient();
    if (polyClient) {
      await polyClient.connect();
      // Re-resolve provider IDs on the new connection
      const polyProviderIds = await getProviderIds(polyClient);
      if (polyProviderIds) {
        await ingestPolymarketSports(polyClient, polyProviderIds.polymarket, observedAt, report);
      } else {
        console.warn("[sports-universe] Could not resolve provider IDs for Polymarket client; skipping");
      }
      await polyClient.end();
    } else {
      console.warn("[sports-universe] No DATABASE_URL for Polymarket client; skipping");
    }
  } finally {
    releaseLock();
  }

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
