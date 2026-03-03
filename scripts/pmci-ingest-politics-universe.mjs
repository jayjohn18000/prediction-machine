#!/usr/bin/env node
/**
 * Politics universe ingestion (PMCI Phase 1).
 *
 * Ingests POLITICS markets beyond paired config:
 * - Kalshi: events by series_ticker -> markets by event_ticker (throttled, 429 retry, optional checkpoint)
 * - Polymarket: events by tag_id -> markets within event
 *
 * Writes to:
 * - pmci.provider_markets (upsert)
 * - pmci.provider_market_snapshots (append when price_yes available)
 *
 * Env:
 *   DATABASE_URL (required)
 *   PMCI_POLITICS_KALSHI_SERIES_TICKERS (optional; if missing, skips Kalshi)
 *   PMCI_POLITICS_REQUEST_DELAY_MS=250 (delay between Kalshi request chunks)
 *   PMCI_POLITICS_KALSHI_CONCURRENCY=1 (events per chunk)
 *   PMCI_POLITICS_KALSHI_MAX_EVENTS=50 (cap Kalshi events per run)
 *   PMCI_POLITICS_KALSHI_MAX_RETRIES=6 (429/5xx retries with backoff)
 *   PMCI_POLITICS_MAX_EVENTS_PER_PROVIDER (default 50; used for Poly and Kalshi max if KALSHI_MAX_EVENTS not set)
 *   PMCI_POLITICS_POLY_TAG_ID, PMCI_POLITICS_POLY_CONCURRENCY, etc.
 *   PMCI_POLITICS_POLY_SLUG_KEYWORDS (optional; comma-separated, e.g. "nominee,primary,presidential,2028" to also fetch events by search)
 *
 * Resume: writes .pmci_kalshi_universe_checkpoint.json; pass --reset to ignore and start fresh.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createPmciClient, getProviderIds, ingestProviderMarket, addIngestionCounts } from '../lib/pmci-ingestion.mjs';

const KALSHI_CHECKPOINT_PATH = '.pmci_kalshi_universe_checkpoint.json';
const RESET_FLAG = '--reset';

const KALSHI_BASES = [
  'https://api.elections.kalshi.com/trade-api/v2',
  'https://api.kalshi.com/trade-api/v2',
];
const POLYMARKET_BASE = 'https://gamma-api.polymarket.com';

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  try {
    const env = fs.readFileSync(envPath, 'utf8');
    env.split('\n').forEach((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    });
  } catch (_) {}
}
loadEnv();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseNum(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

function clamp01(n) {
  if (n == null || Number.isNaN(n)) return null;
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(1, x));
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

function splitCsv(s) {
  return String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Kalshi request with 429/5xx retry. Respects Retry-After; else exponential backoff (0.5s, 1s, 2s, 4s, 8s… cap 30s). */
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
    const retryAfter = res.headers.get('Retry-After');
    if (retryAfter != null) {
      const sec = parseInt(retryAfter, 10);
      if (!Number.isNaN(sec)) waitMs = Math.min(sec * 1000, 30000);
    } else {
      waitMs = Math.min(waitMs, 30000);
    }
    console.warn(`pmci:politics:universe kalshi HTTP ${res.status} for ${url.slice(0, 80)}… retry ${attempt + 1}/${maxRetries} in ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
  }
  throw lastErr;
}

function readKalshiCheckpoint(reset) {
  if (reset) return null;
  try {
    const p = path.join(process.cwd(), KALSHI_CHECKPOINT_PATH);
    const raw = fs.readFileSync(p, 'utf8');
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
      'utf8',
    );
  } catch (err) {
    console.warn('pmci:politics:universe kalshi checkpoint write failed:', err.message);
  }
}

async function ingestKalshiUniverse(pmciClient, providerId, opts) {
  const seriesTickers = splitCsv(process.env.PMCI_POLITICS_KALSHI_SERIES_TICKERS);
  if (seriesTickers.length === 0) {
    console.log('pmci:politics:universe kalshi: skip (PMCI_POLITICS_KALSHI_SERIES_TICKERS not set)');
    return { eventsVisited: 0, marketsUpserted: 0, snapshotsAppended: 0, retries_count: 0, rate_limited_count: 0 };
  }

  const delayMs = Number(process.env.PMCI_POLITICS_REQUEST_DELAY_MS || '250');
  const concurrency = Math.max(1, Math.min(10, Number(process.env.PMCI_POLITICS_KALSHI_CONCURRENCY || '1')));
  const maxEvents = Number(process.env.PMCI_POLITICS_KALSHI_MAX_EVENTS || process.env.PMCI_POLITICS_MAX_EVENTS_PER_PROVIDER || '50');
  const maxRetries = Math.max(1, Number(process.env.PMCI_POLITICS_KALSHI_MAX_RETRIES || '6'));
  const reset = process.argv.includes(RESET_FLAG);

  const report = {
    eventsVisited: 0,
    marketsUpserted: 0,
    snapshotsAppended: 0,
    retries_count: 0,
    rate_limited_count: 0,
    total_events_attempted: 0,
    last_event_ticker: null,
  };

  const checkpoint = readKalshiCheckpoint(reset);
  let skipUntilEventTicker = null;
  let seriesStartIndex = 0;
  if (checkpoint?.series_ticker) {
    const idx = seriesTickers.indexOf(checkpoint.series_ticker);
    if (idx >= 0) {
      seriesStartIndex = idx;
      skipUntilEventTicker = checkpoint.last_event_ticker_processed || null;
      console.log('pmci:politics:universe kalshi resume from series=%s after event=%s', checkpoint.series_ticker, skipUntilEventTicker || '(none)');
    }
  }

  let kalshiBase = null;
  for (const b of KALSHI_BASES) {
    try {
      const u = new URL(`${b}/events`);
      u.searchParams.set('limit', '1');
      await fetchKalshiWithRetry(u.toString(), { maxRetries: 2, stats: report });
      kalshiBase = b;
      break;
    } catch (_) {}
  }
  if (!kalshiBase) {
    throw new Error('kalshi: could not verify any API base');
  }

  const base = kalshiBase;
  const observedAt = new Date().toISOString();

  for (let si = seriesStartIndex; si < seriesTickers.length; si++) {
    const seriesTicker = seriesTickers[si];
    let cursor = null;
    let seenResumeMarker = !skipUntilEventTicker;

    while (report.eventsVisited < maxEvents) {
      const url = new URL(`${base}/events`);
      url.searchParams.set('series_ticker', seriesTicker);
      url.searchParams.set('limit', '200');
      if (cursor) url.searchParams.set('cursor', cursor);

      const data = await fetchKalshiWithRetry(url.toString(), { maxRetries, stats: report });
      const events = Array.isArray(data?.events) ? data.events : [];
      if (events.length === 0) break;

      const eventTickersToProcess = [];
      for (const ev of events) {
        if (report.eventsVisited >= maxEvents) break;
        const eventTicker = ev?.event_ticker || ev?.ticker;
        if (!eventTicker) continue;

        if (!seenResumeMarker) {
          if (eventTicker === skipUntilEventTicker) seenResumeMarker = true;
          continue;
        }
        eventTickersToProcess.push({ ev, eventTicker });
      }

      // Process in chunks of size concurrency: fetch /markets in parallel, then ingest
      for (let c = 0; c < eventTickersToProcess.length; c += concurrency) {
        if (report.eventsVisited >= maxEvents) break;
        const chunk = eventTickersToProcess.slice(c, c + concurrency);
        const marketResponses = await Promise.all(
          chunk.map(({ eventTicker }) => {
            const marketsUrl = new URL(`${base}/markets`);
            marketsUrl.searchParams.set('event_ticker', eventTicker);
            marketsUrl.searchParams.set('limit', '1000');
            return fetchKalshiWithRetry(marketsUrl.toString(), { maxRetries, stats: report }).then((r) => ({
              eventTicker,
              markets: Array.isArray(r?.markets) ? r.markets : [],
            }));
          }),
        );

        for (const { eventTicker, markets } of marketResponses) {
          if (report.eventsVisited >= maxEvents) break;
          report.total_events_attempted += 1;
          report.eventsVisited += 1;
          report.last_event_ticker = eventTicker;

          for (const m of markets) {
            const ticker = m?.ticker;
            if (!ticker) continue;

            const yesAsk = parseNum(m?.yes_ask_dollars ?? m?.last_price_dollars);
            const yesBid = parseNum(m?.yes_bid_dollars);
            const priceYes = clamp01(yesAsk ?? yesBid);

            const result = await ingestProviderMarket(
              pmciClient,
              {
                providerId,
                providerMarketRef: String(ticker),
                eventRef: String(eventTicker),
                title: String(m?.title || m?.subtitle || ticker),
                category: 'politics',
                url: m?.url ? String(m.url) : null,
                openTime: m?.open_time ?? null,
                closeTime: m?.close_time ?? null,
                status: m?.status ? String(m.status) : null,
                metadata: {
                  source: 'pmci-ingest-politics-universe',
                  mode: 'universe',
                  provider: 'kalshi',
                  series_ticker: seriesTicker,
                },
                priceYes,
                bestBidYes: clamp01(yesBid),
                bestAskYes: clamp01(yesAsk),
                liquidity: parseNum(m?.open_interest ?? m?.open_interest_fp) ?? null,
                volume24h: parseNum(m?.volume_24h ?? m?.volume_24h_fp) ?? null,
                raw: m || {},
              },
              observedAt,
            );
            addIngestionCounts(report, result);
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

  return report;
}

function parseOutcomes(m) {
  let out = m?.outcomes ?? m?.outcomeNames ?? null;
  if (typeof out === 'string') {
    try {
      out = JSON.parse(out);
    } catch {
      out = null;
    }
  }
  if (!Array.isArray(out)) return null;
  return out.map((o) => String(o));
}

function parseOutcomePrices(m) {
  let arr = m?.outcomePrices ?? m?.outcome_prices ?? m?.prices ?? null;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch {
      arr = null;
    }
  }
  if (!Array.isArray(arr)) return null;
  return arr
    .map((x) => {
      if (x == null) return null;
      const n = typeof x === 'number' ? x : parseFloat(x);
      return clamp01(n);
    })
    .map((x) => (typeof x === 'number' && !Number.isNaN(x) ? x : null));
}

function findYesPrice(m) {
  const outcomes = Array.isArray(m?.outcomes) ? m.outcomes : null;
  const prices = parseOutcomePrices(m);
  if (!outcomes || !prices || outcomes.length !== prices.length || outcomes.length === 0) return null;

  const idxYes = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
  if (idxYes >= 0) return prices[idxYes] ?? null;

  // Fallback for binary markets that list outcomes in [Yes, No] order.
  if (outcomes.length === 2) return prices[0] ?? null;
  return null;
}

/**
 * Derive a single price from bestBid/bestAsk (mid) or lastTradePrice when outcomePrices are missing.
 * Returns { price: number, source: 'mid' | 'lastTradePrice' } or null if none usable.
 */
function getDerivedPrice(m) {
  const bestBid = parseNum(m?.bestBid ?? m?.best_bid);
  const bestAsk = parseNum(m?.bestAsk ?? m?.best_ask);
  if (bestBid != null && bestAsk != null) {
    const mid = (bestBid + bestAsk) / 2;
    const clamped = clamp01(mid);
    if (clamped != null) return { price: clamped, source: 'mid' };
  }
  const lastTrade = parseNum(m?.lastTradePrice ?? m?.last_trade_price);
  if (lastTrade != null) {
    const clamped = clamp01(lastTrade);
    if (clamped != null) return { price: clamped, source: 'lastTradePrice' };
  }
  return null;
}

const POLY_SLUG_CONCURRENCY = Math.min(5, Math.max(1, Number(process.env.PMCI_POLITICS_POLY_CONCURRENCY || '5')));

async function ingestPolymarketUniverse(pmciClient, providerId, opts) {
  const tagId = (process.env.PMCI_POLITICS_POLY_TAG_ID || '').trim();
  if (!tagId) {
    console.log('pmci:politics:universe polymarket: skip (PMCI_POLITICS_POLY_TAG_ID not set)');
    return {
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
  }

  const maxEvents = opts.maxEvents;
  const delayMs = opts.delayMs;

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
    marketsSkippedSampleLogged: 0,
    skipped_by_reason: {
      missing_outcomes: 0,
      missing_prices: 0,
      parse_error: 0,
      length_mismatch: 0,
    },
  };
  const observedAt = new Date().toISOString();

  // 1) Collect slugs from tag listing (paginate up to maxEvents)
  const slugSet = new Set();
  let offset = 0;
  const limit = 50;
  while (slugSet.size < maxEvents) {
    const url = new URL(`${POLYMARKET_BASE}/events`);
    url.searchParams.set('tag_id', tagId);
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

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

  // 1b) Optional: add slugs from keyword search (e.g. nominee, 2028) so nominee markets enter universe
  const slugKeywords = splitCsv(process.env.PMCI_POLITICS_POLY_SLUG_KEYWORDS || '');
  if (slugKeywords.length > 0) {
    const searchLimit = Math.min(20, Math.max(1, Math.ceil((maxEvents - slugSet.size) / slugKeywords.length)));
    for (const kw of slugKeywords) {
      if (slugSet.size >= maxEvents) break;
      try {
        const searchUrl = new URL(`${POLYMARKET_BASE}/public-search`);
        searchUrl.searchParams.set('q', kw.trim());
        searchUrl.searchParams.set('limit_per_type', String(searchLimit));
        const searchData = await fetchJson(searchUrl.toString());
        const events = Array.isArray(searchData?.events) ? searchData.events : Array.isArray(searchData) ? searchData : [];
        for (const ev of events) {
          const slug = ev?.slug;
          if (slug) slugSet.add(slug);
          if (slugSet.size >= maxEvents) break;
        }
        if (delayMs > 0) await sleep(delayMs);
      } catch (err) {
        console.warn('pmci:politics:universe polymarket slug keyword search q=%s: %s', kw, err.message);
      }
    }
    if (slugSet.size > 0) {
      console.log('pmci:politics:universe polymarket slug_keywords=%j slugs_after_keyword_search=%d', slugKeywords, slugSet.size);
    }
  }

  const slugs = [...slugSet];

  // 2) Always fetch full event by slug (listing returns partial markets without outcomePrices)
  for (let i = 0; i < slugs.length; i += POLY_SLUG_CONCURRENCY) {
    const chunk = slugs.slice(i, i + POLY_SLUG_CONCURRENCY);
    if (delayMs > 0 && i > 0) await sleep(delayMs);

    const fullEvents = await Promise.all(
      chunk.map((slug) =>
        fetchJson(`${POLYMARKET_BASE}/events/slug/${encodeURIComponent(slug)}`).catch((err) => {
          console.warn('pmci:politics:universe polymarket fetch slug %s: %s', slug, err.message);
          return null;
        }),
      ),
    );

    for (let j = 0; j < chunk.length; j += 1) {
      const slug = chunk[j];
      const full = fullEvents[j];
      if (!full) continue;

      report.eventsVisited += 1;
      const markets = Array.isArray(full?.markets) ? full.markets : [];
      report.marketsSeen += markets.length;

      let eventSnapshots = 0;

      for (const m of markets) {
        const marketId = m?.id ?? m?.conditionId ?? null;
        if (!marketId) continue;

        let outcomes = null;
        let prices = null;
        let skipReason = null;
        try {
          outcomes = parseOutcomes(m);
          prices = parseOutcomePrices(m);
          if (!outcomes || outcomes.length === 0) skipReason = 'missing_outcomes';
          else if (!prices || outcomes.length !== prices.length) {
            // Try price-derivation fallback before treating as missing_prices
            const derived = getDerivedPrice(m);
            if (derived) {
              prices = null; // signal: use derived path below
              skipReason = null;
            } else {
              skipReason = 'missing_prices';
              report.still_missing_prices += 1;
            }
          }
        } catch (err) {
          skipReason = 'parse_error';
          if (report.skipped_by_reason.parse_error <= 2) {
            console.warn('pmci:politics:universe polymarket parse_error (slug=%s id=%s): %s', slug, marketId, err.message);
          }
        }

        const baseStatus = m?.active === true ? 'open' : m?.closed === true ? 'closed' : null;
        const liquidity = parseNum(m?.liquidity) ?? null;
        const volume24h = parseNum(m?.volume24hr ?? m?.volume_24hr) ?? null;

        // Path 1: outcomePrices available — use them and set price_source = "outcomePrices"
        if (!skipReason && outcomes && outcomes.length > 0 && prices && prices.length === outcomes.length) {
          for (let k = 0; k < outcomes.length; k += 1) {
            const outcomeName = String(outcomes[k] ?? '').trim();
            const priceYes = prices[k];
            if (priceYes == null) continue;

            const providerMarketRef = `${slug}#${outcomeName}`;
            const title = String(m?.question || m?.title || providerMarketRef);

            const result = await ingestProviderMarket(
              pmciClient,
              {
                providerId,
                providerMarketRef,
                eventRef: String(slug),
                title,
                category: 'politics',
                status: baseStatus,
                metadata: {
                  source: 'pmci-ingest-politics-universe',
                  mode: 'universe',
                  provider: 'polymarket',
                  tag_id: tagId,
                  market_id: marketId,
                  outcome_index: k,
                  outcome_name: outcomeName,
                },
                priceYes,
                bestBidYes: null,
                bestAskYes: null,
                liquidity,
                volume24h,
                raw: {
                  ...m,
                  _pmci: {
                    source: 'pmci-ingest-politics-universe',
                    mode: 'universe',
                    provider: 'polymarket',
                    slug,
                    tag_id: tagId,
                    market_id: marketId,
                    outcome_index: k,
                    outcome_name: outcomeName,
                    price_source: 'outcomePrices',
                  },
                },
              },
              observedAt,
            );
            addIngestionCounts(report, result);
            report.snapshots_from_outcomePrices += result.snapshotsAppended ?? 0;
            eventSnapshots += result.snapshotsAppended ?? 0;
          }
          continue;
        }

        // Path 2: no outcomePrices but derived price (mid or lastTradePrice) — ingest Yes outcome only
        if (!skipReason && outcomes && outcomes.length > 0 && !prices) {
          const derived = getDerivedPrice(m);
          if (derived) {
            const yesIdx = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
            const idxYes = yesIdx >= 0 ? yesIdx : outcomes.length === 2 ? 0 : 0;
            const outcomeName = String(outcomes[idxYes] ?? 'Yes').trim();
            const providerMarketRef = `${slug}#${outcomeName}`;
            const title = String(m?.question || m?.title || providerMarketRef);

            const result = await ingestProviderMarket(
              pmciClient,
              {
                providerId,
                providerMarketRef,
                eventRef: String(slug),
                title,
                category: 'politics',
                status: baseStatus,
                metadata: {
                  source: 'pmci-ingest-politics-universe',
                  mode: 'universe',
                  provider: 'polymarket',
                  tag_id: tagId,
                  market_id: marketId,
                  outcome_index: idxYes,
                  outcome_name: outcomeName,
                },
                priceYes: derived.price,
                bestBidYes: null,
                bestAskYes: null,
                liquidity,
                volume24h,
                raw: {
                  ...m,
                  _pmci: {
                    source: 'pmci-ingest-politics-universe',
                    mode: 'universe',
                    provider: 'polymarket',
                    slug,
                    tag_id: tagId,
                    market_id: marketId,
                    outcome_index: idxYes,
                    outcome_name: outcomeName,
                    price_source: derived.source,
                  },
                },
              },
              observedAt,
            );
            addIngestionCounts(report, result);
            if (derived.source === 'mid') report.snapshots_from_mid += result.snapshotsAppended ?? 0;
            else report.snapshots_from_lastTradePrice += result.snapshotsAppended ?? 0;
            eventSnapshots += result.snapshotsAppended ?? 0;
          } else {
            report.still_missing_prices += 1;
            skipReason = 'missing_prices';
          }
        }

        if (skipReason) {
          report.marketsSkippedMissingOutcomePrices += 1;
          if (report.skipped_by_reason[skipReason] !== undefined) report.skipped_by_reason[skipReason] += 1;
          if (report.marketsSkippedSampleLogged < 3) {
            report.marketsSkippedSampleLogged += 1;
            const keys = Object.keys(m || {});
            console.warn(
              'pmci:politics:universe polymarket skipped market (slug=%s id=%s) reason=%s typeof(outcomes)=%s typeof(outcomePrices)=%s keys=%j preview.outcomes=%s preview.outcomePrices=%s',
              slug,
              marketId,
              skipReason,
              typeof m?.outcomes,
              typeof m?.outcomePrices,
              keys,
              String(m?.outcomes ?? '').slice(0, 200),
              String(m?.outcomePrices ?? '').slice(0, 200),
            );
          }
        }
      }

      if (eventSnapshots === 0 && markets.length > 0) report.eventsSkippedNoPrices += 1;
    }
  }

  return report;
}

async function main() {
  const maxEvents = Number(process.env.PMCI_POLITICS_MAX_EVENTS_PER_PROVIDER || '50');
  const delayMs = Number(process.env.PMCI_POLITICS_REQUEST_DELAY_MS || '250');

  const pmciClient = createPmciClient();
  if (!pmciClient) {
    console.error('DATABASE_URL is required (set it in .env)');
    process.exit(1);
  }
  await pmciClient.connect();

  try {
    const providerIds = await getProviderIds(pmciClient);
    if (!providerIds?.kalshi || !providerIds?.polymarket) {
      throw new Error('pmci.providers missing kalshi or polymarket (apply migrations)');
    }

    const kalshiMaxEvents = Number(process.env.PMCI_POLITICS_KALSHI_MAX_EVENTS || process.env.PMCI_POLITICS_MAX_EVENTS_PER_PROVIDER || '50');
    const kalshiConcurrency = Number(process.env.PMCI_POLITICS_KALSHI_CONCURRENCY || '1');
    console.log('pmci:politics:universe start maxEventsPerProvider=%d delayMs=%d kalshi_max_events=%d kalshi_concurrency=%d', maxEvents, delayMs, kalshiMaxEvents, kalshiConcurrency);

    const kalshi = await ingestKalshiUniverse(pmciClient, providerIds.kalshi, { maxEvents, delayMs });

    let polyLatestBefore = null;
    if (providerIds.polymarket) {
      const r = await pmciClient.query(
        `select max(s.observed_at) as t from pmci.provider_market_snapshots s
         join pmci.provider_markets pm on pm.id = s.provider_market_id where pm.provider_id = $1`,
        [providerIds.polymarket],
      );
      polyLatestBefore = r.rows?.[0]?.t ?? null;
    }

    const poly = await ingestPolymarketUniverse(pmciClient, providerIds.polymarket, { maxEvents, delayMs });

    let polyLatestAfter = null;
    if (providerIds.polymarket) {
      const r = await pmciClient.query(
        `select max(s.observed_at) as t from pmci.provider_market_snapshots s
         join pmci.provider_markets pm on pm.id = s.provider_market_id where pm.provider_id = $1`,
        [providerIds.polymarket],
      );
      polyLatestAfter = r.rows?.[0]?.t ?? null;
    }

    console.log(
      'pmci:politics:universe done kalshi(events_completed=%d total_attempted=%d markets_upserted=%d snapshots=%d retries=%d rate_limited=%d last_event=%s)',
      kalshi.eventsVisited,
      kalshi.total_events_attempted ?? kalshi.eventsVisited,
      kalshi.marketsUpserted,
      kalshi.snapshotsAppended,
      kalshi.retries_count ?? 0,
      kalshi.rate_limited_count ?? 0,
      kalshi.last_event_ticker ?? '',
    );
    console.log(
      'pmci:politics:universe polymarket(events=%d markets_seen=%d outcomes_ingested=%d snapshots=%d events_skipped_no_prices=%d markets_skipped_missing_outcomePrices=%d)',
      poly.eventsVisited,
      poly.marketsSeen ?? poly.marketsUpserted,
      poly.snapshotsAppended,
      poly.snapshotsAppended,
      poly.eventsSkippedNoPrices ?? 0,
      poly.marketsSkippedMissingOutcomePrices ?? 0,
    );
    console.log(
      'pmci:politics:universe polymarket price_source: snapshots_from_outcomePrices=%d snapshots_from_mid=%d snapshots_from_lastTradePrice=%d still_missing_prices=%d (still_missing_prices should drop vs previous 364 with fallback)',
      poly.snapshots_from_outcomePrices ?? 0,
      poly.snapshots_from_mid ?? 0,
      poly.snapshots_from_lastTradePrice ?? 0,
      poly.still_missing_prices ?? 0,
    );
    if (poly.skipped_by_reason && Object.keys(poly.skipped_by_reason).length > 0) {
      console.log('pmci:politics:universe polymarket skipped_by_reason: %j', poly.skipped_by_reason);
    }

    if (poly.eventsVisited > 0 && poly.snapshotsAppended === 0) {
      console.error(
        'pmci:politics:universe FAIL: polymarket had %d events but appended 0 snapshots (full event fetch may lack outcomePrices)',
        poly.eventsVisited,
      );
      process.exit(1);
    }

    if (poly.snapshotsAppended > 0 && polyLatestBefore != null && polyLatestAfter != null) {
      const beforeTs = new Date(polyLatestBefore).getTime();
      const afterTs = new Date(polyLatestAfter).getTime();
      if (afterTs <= beforeTs) {
        console.error(
          'pmci:politics:universe FAIL: polymarket latest_observed_at did not advance (before=%s after=%s)',
          polyLatestBefore,
          polyLatestAfter,
        );
        process.exit(1);
      }
      console.log('pmci:politics:universe polymarket latest_observed_at advanced (before=%s after=%s)', polyLatestBefore, polyLatestAfter);
    }
  } finally {
    await pmciClient.end();
  }
}

main().catch((err) => {
  console.error('pmci:politics:universe FAIL:', err.message);
  process.exit(1);
});

