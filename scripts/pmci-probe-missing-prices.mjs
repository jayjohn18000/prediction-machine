#!/usr/bin/env node
/**
 * Minimal probe: fetch one Polymarket event by slug and print up to 3 market
 * objects that have outcomes but missing/empty outcomePrices (missing_prices).
 * No DATABASE_URL required. Use to audit raw shape: lastTradePrice, bestBid, bestAsk.
 *
 * Usage:
 *   node scripts/pmci-probe-missing-prices.mjs [slug]
 *   PMCI_POLITICS_POLY_TAG_ID=123 node scripts/pmci-probe-missing-prices.mjs
 * If slug is omitted and PMCI_POLITICS_POLY_TAG_ID is set, fetches first event from tag.
 * If neither, uses a default slug (e.g. fed-decision-in-october).
 */

const POLYMARKET_BASE = 'https://gamma-api.polymarket.com';

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
  return arr;
}

async function main() {
  const wantSamples = 3;
  const missingPricesSamples = [];
  let slugsToTry = process.argv[2] ? [process.argv[2]] : null;

  if (!slugsToTry?.length) {
    const tagId = (process.env.PMCI_POLITICS_POLY_TAG_ID || '').trim();
    if (tagId) {
      const url = new URL(`${POLYMARKET_BASE}/events`);
      url.searchParams.set('tag_id', tagId);
      url.searchParams.set('active', 'true');
      url.searchParams.set('closed', 'false');
      url.searchParams.set('limit', '50');
      const data = await fetchJson(url.toString());
      const events = Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : [];
      slugsToTry = events.map((e) => e?.slug).filter(Boolean);
    }
    if (!slugsToTry?.length) slugsToTry = ['fed-decision-in-october'];
  }

  console.log('Checking up to %d events for markets with outcomes but missing outcomePrices...', slugsToTry.length);

  for (const slug of slugsToTry) {
    if (missingPricesSamples.length >= wantSamples) break;
    try {
      const full = await fetchJson(`${POLYMARKET_BASE}/events/slug/${encodeURIComponent(slug)}`);
      const markets = Array.isArray(full?.markets) ? full.markets : [];
      for (const m of markets) {
        if (missingPricesSamples.length >= wantSamples) break;
        const outcomes = parseOutcomes(m);
        const prices = parseOutcomePrices(m);
        const hasOutcomes = outcomes && outcomes.length > 0;
        const missingPrices = !prices || !Array.isArray(prices) || prices.length === 0;
        if (hasOutcomes && missingPrices) {
          missingPricesSamples.push({
            slug,
            id: m?.id ?? m?.conditionId,
            question: (m?.question || m?.title || '').slice(0, 80),
            outcomes,
            outcomePrices: m?.outcomePrices ?? m?.outcome_prices ?? m?.prices,
            lastTradePrice: m?.lastTradePrice,
            bestBid: m?.bestBid,
            bestAsk: m?.bestAsk,
            allKeys: Object.keys(m || {}),
            rawPriceLike: {
              lastTradePrice: m?.lastTradePrice,
              bestBid: m?.bestBid,
              bestAsk: m?.bestAsk,
              outcomePrices: m?.outcomePrices,
              outcome_prices: m?.outcome_prices,
              prices: m?.prices,
              enableOrderBook: m?.enableOrderBook,
            },
          });
        }
      }
    } catch (err) {
      console.warn('Skip slug %s: %s', slug, err.message);
    }
  }

  console.log('\n--- Markets with outcomes but missing/empty outcomePrices: %d ---', missingPricesSamples.length);
  console.log(JSON.stringify(missingPricesSamples, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
