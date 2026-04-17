/**
 * Economics / macro universe ingestion (Phase E3 parallel track).
 * Kalshi macro series + Polymarket tag / keyword discovery.
 * Category: `economics` on pmci.provider_markets.
 *
 * Env:
 *   DATABASE_URL (required)
 *   PMCI_ECONOMICS_KALSHI_SERIES_TICKERS — comma list (default: KXFEDDECISION,KXRATECUTCOUNT)
 *   PMCI_ECONOMICS_KALSHI_MAX_EVENTS — cap per run (default 40)
 *   PMCI_ECONOMICS_POLY_TAG_ID — optional Gamma tag_id for macro events
 *   PMCI_ECONOMICS_POLY_SLUG_KEYWORDS — comma keywords for public-search (default: fed,fomc,cpi)
 *   PMCI_ECONOMICS_MAX_EVENTS_PER_PROVIDER — poly event cap (default 40)
 */

import fs from "node:fs";
import path from "node:path";
import {
  createPmciClient,
  getProviderIds,
  ingestProviderMarket,
  addIngestionCounts,
  backfillEmbeddings,
} from "../pmci-ingestion.mjs";
import { maybeApplyTemplateAfterIngest } from "../matching/templates/ingest-classify.mjs";
import { parseNum, clamp01, parseOutcomes, parseOutcomePrices, getDerivedPrice } from "./services/price-parsers.mjs";

const KALSHI_CHECKPOINT_PATH = ".pmci_kalshi_economics_checkpoint.json";
const KALSHI_BASES = [
  "https://api.elections.kalshi.com/trade-api/v2",
  "https://api.kalshi.com/trade-api/v2",
];
const POLYMARKET_BASE = "https://gamma-api.polymarket.com";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function splitCsv(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function isLikelyEconomicsText(text) {
  const t = String(text || "").toLowerCase();
  return /(fed|fomc|cpi|nfp|jobs report|unemployment|rate cut|interest rate|gdp|inflation|recession|treasury|ecb|macro|powell|beige book|dot plot)/.test(
    t,
  );
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {}
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || text.slice(0, 200);
    throw new Error(`HTTP ${res.status} for ${url}: ${msg}`);
  }
  return data;
}

async function fetchKalshiWithRetry(url, opts) {
  const { maxRetries = 6, stats = { retries_count: 0, rate_limited_count: 0 } } = opts || {};
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {}

    if (res.ok) return data;

    const is429 = res.status === 429;
    const is5xx = res.status >= 500 && res.status < 600;
    const is4xxNot429 = res.status >= 400 && res.status < 500 && !is429;

    if (is4xxNot429) {
      const msg = data?.error?.message || data?.message || text.slice(0, 200);
      throw new Error(`HTTP ${res.status} for ${url}: ${msg}`);
    }

    if (attempt === maxRetries) {
      lastErr = new Error(`HTTP ${res.status} for ${url} after ${maxRetries} retries`);
      break;
    }

    if (is429) stats.rate_limited_count += 1;
    stats.retries_count += 1;

    let waitMs = 500 * Math.pow(2, attempt);
    const retryAfter = res.headers.get("Retry-After");
    if (retryAfter != null) {
      const sec = parseInt(retryAfter, 10);
      if (!Number.isNaN(sec)) waitMs = Math.min(sec * 1000, 30000);
    } else {
      waitMs = Math.min(waitMs, 30000);
    }
    await sleep(waitMs);
  }
  throw lastErr;
}

function readKalshiCheckpoint(reset) {
  if (reset) return null;
  try {
    const p = path.join(process.cwd(), KALSHI_CHECKPOINT_PATH);
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function writeKalshiCheckpoint(seriesTicker, lastEventTicker, eventsCompleted) {
  try {
    const p = path.join(process.cwd(), KALSHI_CHECKPOINT_PATH);
    fs.writeFileSync(
      p,
      JSON.stringify({
        series_ticker: seriesTicker,
        last_event_ticker_processed: lastEventTicker,
        events_completed: eventsCompleted,
        timestamp: new Date().toISOString(),
      }),
      "utf8",
    );
  } catch (err) {
    console.warn("pmci:economics:universe kalshi checkpoint write failed:", err.message);
  }
}

async function ingestKalshiEconomics(pmciClient, providerId, opts) {
  const seriesTickers = splitCsv(
    process.env.PMCI_ECONOMICS_KALSHI_SERIES_TICKERS || "KXFEDDECISION,KXRATECUTCOUNT",
  );
  if (seriesTickers.length === 0) {
    console.log("pmci:economics:universe kalshi: skip (PMCI_ECONOMICS_KALSHI_SERIES_TICKERS empty)");
    return {
      eventsVisited: 0,
      marketsUpserted: 0,
      snapshotsAppended: 0,
      retries_count: 0,
      rate_limited_count: 0,
    };
  }

  const delayMs = Number(process.env.PMCI_ECONOMICS_REQUEST_DELAY_MS || "250");
  const concurrency = Math.max(
    1,
    Math.min(10, Number(process.env.PMCI_ECONOMICS_KALSHI_CONCURRENCY || "1")),
  );
  const maxEvents = Number(
    process.env.PMCI_ECONOMICS_KALSHI_MAX_EVENTS ||
      process.env.PMCI_ECONOMICS_MAX_EVENTS_PER_PROVIDER ||
      "40",
  );
  const maxRetries = Math.max(1, Number(process.env.PMCI_ECONOMICS_KALSHI_MAX_RETRIES || "6"));
  const reset = opts.reset === true;

  const report = {
    eventsVisited: 0,
    marketsUpserted: 0,
    snapshotsAppended: 0,
    retries_count: 0,
    rate_limited_count: 0,
    total_events_attempted: 0,
    last_event_ticker: null,
  };

  const collectedIds = [];
  const checkpoint = readKalshiCheckpoint(reset);
  let skipUntilEventTicker = null;
  let checkpointSeriesTicker = null;
  if (checkpoint?.series_ticker) {
    checkpointSeriesTicker = checkpoint.series_ticker;
    skipUntilEventTicker = checkpoint.last_event_ticker_processed || null;
  }

  let kalshiBase = null;
  for (const b of KALSHI_BASES) {
    try {
      const u = new URL(`${b}/events`);
      u.searchParams.set("limit", "1");
      await fetchKalshiWithRetry(u.toString(), { maxRetries: 2, stats: report });
      kalshiBase = b;
      break;
    } catch (_) {}
  }
  if (!kalshiBase) throw new Error("kalshi: could not verify any API base");

  const observedAt = new Date().toISOString();
  const activeSeries = seriesTickers;

  let seriesStartIndex = 0;
  if (checkpointSeriesTicker) {
    const idx = activeSeries.indexOf(checkpointSeriesTicker);
    if (idx >= 0) seriesStartIndex = idx;
    else skipUntilEventTicker = null;
  }

  for (let si = seriesStartIndex; si < activeSeries.length; si++) {
    const seriesTicker = activeSeries[si];
    let cursor = null;
    let seenResumeMarker = !skipUntilEventTicker;
    let seriesVisited = 0;
    const perSeriesBudget = Math.ceil(maxEvents / Math.max(activeSeries.length, 1));

    while (report.eventsVisited < maxEvents && seriesVisited < perSeriesBudget) {
      const url = new URL(`${kalshiBase}/events`);
      url.searchParams.set("series_ticker", seriesTicker);
      url.searchParams.set("limit", "200");
      if (cursor) url.searchParams.set("cursor", cursor);

      const data = await fetchKalshiWithRetry(url.toString(), { maxRetries, stats: report });
      const events = Array.isArray(data?.events) ? data.events : [];
      if (events.length === 0) break;

      const eventTickersToProcess = [];
      for (const ev of events) {
        if (report.eventsVisited >= maxEvents || seriesVisited >= perSeriesBudget) break;
        const eventTicker = ev?.event_ticker || ev?.ticker;
        if (!eventTicker) continue;
        if (!seenResumeMarker) {
          if (eventTicker === skipUntilEventTicker) seenResumeMarker = true;
          continue;
        }
        eventTickersToProcess.push({ ev, eventTicker });
      }

      for (let c = 0; c < eventTickersToProcess.length; c += concurrency) {
        if (report.eventsVisited >= maxEvents || seriesVisited >= perSeriesBudget) break;
        const chunk = eventTickersToProcess.slice(c, c + concurrency);
        const marketResponses = await Promise.all(
          chunk.map(({ eventTicker }) => {
            const marketsUrl = new URL(`${kalshiBase}/markets`);
            marketsUrl.searchParams.set("event_ticker", eventTicker);
            marketsUrl.searchParams.set("limit", "1000");
            return fetchKalshiWithRetry(marketsUrl.toString(), { maxRetries, stats: report }).then((r) => ({
              eventTicker,
              markets: Array.isArray(r?.markets) ? r.markets : [],
            }));
          }),
        );

        for (const { eventTicker, markets } of marketResponses) {
          if (report.eventsVisited >= maxEvents || seriesVisited >= perSeriesBudget) break;
          report.total_events_attempted += 1;
          report.eventsVisited += 1;
          seriesVisited += 1;
          report.last_event_ticker = eventTicker;

          for (const m of markets) {
            const ticker = m?.ticker;
            if (!ticker) continue;
            const yesAsk = parseNum(m?.yes_ask_dollars ?? m?.last_price_dollars);
            const yesBid = parseNum(m?.yes_bid_dollars);
            const priceYes = clamp01(yesAsk ?? yesBid);
            const marketTitle = String(m?.title || m?.subtitle || ticker);
            const eventText = `${seriesTicker} ${eventTicker} ${marketTitle}`;
            if (!isLikelyEconomicsText(eventText)) continue;

            const result = await ingestProviderMarket(
              pmciClient,
              {
                providerId,
                providerMarketRef: String(ticker),
                eventRef: String(eventTicker),
                title: marketTitle,
                category: "economics",
                url: m?.url ? String(m.url) : null,
                openTime: m?.open_time ?? null,
                closeTime: m?.close_time ?? null,
                status: m?.status ? String(m.status) : null,
                metadata: {
                  source: "pmci-ingest-economics-universe",
                  mode: "universe",
                  provider: "kalshi",
                  series_ticker: seriesTicker,
                  track: "economics",
                },
                priceYes,
                bestBidYes: clamp01(yesBid),
                bestAskYes: clamp01(yesAsk),
                liquidity: parseNum(m?.open_interest ?? m?.open_interest_fp) ?? null,
                volume24h: parseNum(m?.volume_24h ?? m?.volume_24h_fp) ?? null,
                raw: m || {},
              },
              observedAt,
              { skipEmbedding: true },
            );
            addIngestionCounts(report, result);
            if (result.providerMarketId) {
              collectedIds.push(result.providerMarketId);
              await maybeApplyTemplateAfterIngest(pmciClient, {
                id: result.providerMarketId,
                title: marketTitle,
                provider_market_ref: String(ticker),
                provider_id: providerId,
                category: "economics",
              });
            }
          }
          writeKalshiCheckpoint(seriesTicker, eventTicker, report.eventsVisited);
        }
        if (delayMs > 0) await sleep(delayMs);
      }

      cursor = data?.cursor || data?.next_cursor || null;
      if (!cursor) break;
      if (delayMs > 0) await sleep(delayMs);
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  if (collectedIds.length > 0) {
    const filled = await backfillEmbeddings(pmciClient, collectedIds);
    console.log(`pmci:economics:universe kalshi: backfilled ${filled} embeddings for ${collectedIds.length} markets`);
  }

  return report;
}

async function ingestPolymarketEconomics(pmciClient, providerId, opts) {
  const maxEvents = opts.maxEvents;
  const delayMs = opts.delayMs;
  const tagId = (process.env.PMCI_ECONOMICS_POLY_TAG_ID || "").trim();
  const slugKeywords = splitCsv(
    process.env.PMCI_ECONOMICS_POLY_SLUG_KEYWORDS || "fed,fomc,cpi,rate cut",
  );

  const report = {
    eventsVisited: 0,
    marketsSeen: 0,
    marketsUpserted: 0,
    snapshotsAppended: 0,
    eventsSkippedNoPrices: 0,
    marketsSkippedMissingOutcomePrices: 0,
    snapshots_from_outcomePrices: 0,
    snapshots_from_mid: 0,
    snapshots_from_lastTradePrice: 0,
    still_missing_prices: 0,
    skipped_by_reason: {},
  };
  const observedAt = new Date().toISOString();
  const collectedIds = [];
  const slugSet = new Set();

  if (tagId) {
    let offset = 0;
    const limit = 50;
    while (slugSet.size < maxEvents) {
      const url = new URL(`${POLYMARKET_BASE}/events`);
      url.searchParams.set("tag_id", tagId);
      url.searchParams.set("active", "true");
      url.searchParams.set("closed", "false");
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      const data = await fetchJson(url.toString());
      const events = Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : [];
      if (!events.length) break;
      for (const ev of events) {
        const slug = ev?.slug;
        if (slug) slugSet.add(slug);
        if (slugSet.size >= maxEvents) break;
      }
      offset += events.length;
      if (events.length < limit) break;
    }
  }

  for (const kw of slugKeywords) {
    if (slugSet.size >= maxEvents) break;
    try {
      const searchUrl = new URL(`${POLYMARKET_BASE}/public-search`);
      searchUrl.searchParams.set("q", kw.trim());
      searchUrl.searchParams.set("limit_per_type", "15");
      const searchData = await fetchJson(searchUrl.toString());
      const events = Array.isArray(searchData?.events) ? searchData.events : [];
      for (const ev of events) {
        const slug = ev?.slug;
        if (slug) slugSet.add(slug);
        if (slugSet.size >= maxEvents) break;
      }
      if (delayMs > 0) await sleep(delayMs);
    } catch (err) {
      console.warn("pmci:economics:universe polymarket search q=%s: %s", kw, err.message);
    }
  }

  const slugs = [...slugSet];
  for (const slug of slugs) {
    if (delayMs > 0) await sleep(delayMs);
    let full;
    try {
      full = await fetchJson(`${POLYMARKET_BASE}/events/slug/${encodeURIComponent(slug)}`);
    } catch {
      continue;
    }
    report.eventsVisited += 1;
    const markets = Array.isArray(full?.markets) ? full.markets : [];
    report.marketsSeen += markets.length;

    for (const m of markets) {
      const marketId = m?.id ?? m?.conditionId ?? null;
      if (!marketId) continue;
      let outcomes;
      let prices;
      try {
        outcomes = parseOutcomes(m);
        prices = parseOutcomePrices(m);
      } catch {
        continue;
      }
      if (!outcomes?.length) continue;

      const baseStatus = m?.active === true ? "open" : m?.closed === true ? "closed" : null;
      const liquidity = parseNum(m?.liquidity) ?? null;
      const volume24h = parseNum(m?.volume24hr ?? m?.volume_24hr) ?? null;

      const isBinaryYesNo =
        outcomes?.length === 2 &&
        outcomes[0]?.toLowerCase() === "yes" &&
        outcomes[1]?.toLowerCase() === "no";

      if (prices && outcomes.length === prices.length) {
        for (let k = 0; k < outcomes.length; k++) {
          const outcomeName = String(outcomes[k] ?? "").trim();
          const priceYes = prices[k];
          if (priceYes == null) continue;
          const providerMarketRef = `${slug}#${outcomeName}`;
          const title = String(m?.question || m?.title || providerMarketRef);
          if (!isLikelyEconomicsText(`${slug} ${title}`)) continue;

          const result = await ingestProviderMarket(
            pmciClient,
            {
              providerId,
              providerMarketRef,
              eventRef: String(slug),
              title,
              category: "economics",
              status: baseStatus,
              metadata: {
                source: "pmci-ingest-economics-universe",
                mode: "universe",
                provider: "polymarket",
                tag_id: tagId || null,
                market_id: marketId,
                outcome_index: k,
                outcome_name: outcomeName,
                track: "economics",
              },
              priceYes,
              bestBidYes: null,
              bestAskYes: null,
              liquidity,
              volume24h,
              raw: {
                ...m,
                _pmci: { source: "pmci-ingest-economics-universe", slug, outcome_name: outcomeName },
              },
            },
            observedAt,
            { skipEmbedding: true },
          );
          addIngestionCounts(report, result);
          if (result.providerMarketId) {
            collectedIds.push(result.providerMarketId);
            await maybeApplyTemplateAfterIngest(pmciClient, {
              id: result.providerMarketId,
              title,
              provider_market_ref: providerMarketRef,
              provider_id: providerId,
              category: "economics",
            });
          }
          report.snapshots_from_outcomePrices += result.snapshotsAppended ?? 0;
        }
        continue;
      }

      const derived = getDerivedPrice(m);
      if (derived && isBinaryYesNo) {
        const outcomeName = "Yes";
        const providerMarketRef = `${slug}#${outcomeName}`;
        const title = String(m?.question || m?.title || providerMarketRef);
        if (!isLikelyEconomicsText(`${slug} ${title}`)) continue;
        const result = await ingestProviderMarket(
          pmciClient,
          {
            providerId,
            providerMarketRef,
            eventRef: String(slug),
            title,
            category: "economics",
            status: baseStatus,
            metadata: {
              source: "pmci-ingest-economics-universe",
              provider: "polymarket",
              market_id: marketId,
              track: "economics",
            },
            priceYes: derived.price,
            bestBidYes: null,
            bestAskYes: null,
            liquidity,
            volume24h,
            raw: m,
          },
          observedAt,
          { skipEmbedding: true },
        );
        addIngestionCounts(report, result);
        if (result.providerMarketId) {
          collectedIds.push(result.providerMarketId);
          await maybeApplyTemplateAfterIngest(pmciClient, {
            id: result.providerMarketId,
            title,
            provider_market_ref: providerMarketRef,
            provider_id: providerId,
            category: "economics",
          });
        }
      }
    }
    if (report.snapshotsAppended === 0 && markets.length > 0) report.eventsSkippedNoPrices += 1;
  }

  if (collectedIds.length > 0) {
    const filled = await backfillEmbeddings(pmciClient, collectedIds);
    console.log(`pmci:economics:universe polymarket: backfilled ${filled} embeddings`);
  }

  return report;
}

export async function runEconomicsUniverseIngest(opts = {}) {
  const reset = opts.reset === true;
  const maxEvents = Number(process.env.PMCI_ECONOMICS_MAX_EVENTS_PER_PROVIDER || "40");
  const delayMs = Number(process.env.PMCI_ECONOMICS_REQUEST_DELAY_MS || "250");

  const pmciClient = createPmciClient();
  if (!pmciClient) throw new Error("DATABASE_URL is required");
  await pmciClient.connect();

  try {
    const providerIds = await getProviderIds(pmciClient);
    if (!providerIds?.kalshi || !providerIds?.polymarket) {
      throw new Error("pmci.providers missing kalshi or polymarket");
    }

    const kalshi = await ingestKalshiEconomics(pmciClient, providerIds.kalshi, { reset });
    const poly = await ingestPolymarketEconomics(pmciClient, providerIds.polymarket, {
      maxEvents,
      delayMs,
    });

    const summary = `kalshi events=${kalshi.eventsVisited} markets=${kalshi.marketsUpserted}; poly events=${poly.eventsVisited} snapshots=${poly.snapshotsAppended}`;
    let ok = true;
    if (poly.eventsVisited > 0 && poly.snapshotsAppended === 0) ok = false;
    return { ok, summary, kalshi, poly };
  } finally {
    await pmciClient.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith("economics-universe.mjs")) {
  runEconomicsUniverseIngest({ reset: process.argv.includes("--reset") })
    .then((r) => {
      console.log(r.summary);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
