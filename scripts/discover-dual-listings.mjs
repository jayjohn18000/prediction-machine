#!/usr/bin/env node
/**
 * Generic dual-listings discovery CLI.
 *
 * For now this is focused on a single Kalshi + Polymarket event pair:
 * - Takes Kalshi event_ticker
 * - Takes Polymarket event slug
 * - Maps both into canonical events and writes a JSON file containing
 *   per-market/outcome mappings suitable for spread observers.
 *
 * Usage:
 *   node scripts/discover-dual-listings.mjs KALSHI_EVENT_TICKER POLYMARKET_EVENT_SLUG
 *
 * Example:
 *   node scripts/discover-dual-listings.mjs KXPRESNOMD-28 democratic-presidential-nominee-2028
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mapKalshiEventToCanonical } from '../lib/providers/kalshi-adapter.mjs';
import { mapPolymarketEventToCanonical } from '../lib/providers/polymarket-adapter.mjs';
import { matchCanonicalEvents } from '../lib/dual-listings.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const POLYMARKET_BASE = 'https://gamma-api.polymarket.com';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

async function fetchKalshiBundle(eventTicker) {
  const eventUrl = new URL(`${KALSHI_BASE}/events`);
  eventUrl.searchParams.set('event_ticker', eventTicker);
  eventUrl.searchParams.set('with_nested_markets', 'false');

  const eventResp = await fetchJson(eventUrl.toString());
  const event = Array.isArray(eventResp?.events) && eventResp.events[0];
  if (!event) {
    throw new Error(`No Kalshi event found for event_ticker=${eventTicker}`);
  }

  const seriesUrl = `${KALSHI_BASE}/series/${encodeURIComponent(event.series_ticker)}`;
  const series = await fetchJson(seriesUrl);

  const marketsUrl = new URL(`${KALSHI_BASE}/markets`);
  marketsUrl.searchParams.set('event_ticker', eventTicker);
  marketsUrl.searchParams.set('limit', '1000');
  const marketsResp = await fetchJson(marketsUrl.toString());
  const markets = Array.isArray(marketsResp?.markets) ? marketsResp.markets : [];

  return { event, series, markets };
}

async function fetchPolymarketBundle(slug) {
  const eventUrl = `${POLYMARKET_BASE}/events/slug/${encodeURIComponent(slug)}`;
  const event = await fetchJson(eventUrl);
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  return { event, markets };
}

async function main() {
  const [kalshiEventTicker, polymarketSlug] = process.argv.slice(2);

  if (!kalshiEventTicker || !polymarketSlug) {
    console.error('Usage: node scripts/discover-dual-listings.mjs KALSHI_EVENT_TICKER POLYMARKET_EVENT_SLUG');
    process.exit(1);
  }

  console.log(`Fetching Kalshi event ${kalshiEventTicker}...`);
  const kalshiBundle = await fetchKalshiBundle(kalshiEventTicker);
  const kalshiCanonical = mapKalshiEventToCanonical(kalshiBundle);

  console.log(`Fetching Polymarket event ${polymarketSlug}...`);
  const polyBundle = await fetchPolymarketBundle(polymarketSlug);
  const polyCanonical = mapPolymarketEventToCanonical(polyBundle);

  const matches = matchCanonicalEvents([kalshiCanonical], [polyCanonical]);
  if (matches.length === 0) {
    console.error('No canonical event matches found between Kalshi and Polymarket.');
    process.exit(1);
  }

  const [{ left: leftEvent, right: rightEvent }] = matches;

  // Build a simple per-candidate mapping by matching market-level outcome labels.
  const pairs = [];

  for (const kalshiMarket of leftEvent.markets) {
    const kalshiYes = kalshiMarket.outcomes.find((o) => o.role === 'yes');
    if (!kalshiYes) continue;
    const kalshiLabelSlug = kalshiYes.label && kalshiYes.label.toLowerCase();

    for (const polyMarket of rightEvent.markets) {
      const polyYes = polyMarket.outcomes.find((o) => o.role === 'yes');
      if (!polyYes) continue;
      const polyQuestion = polyMarket.title || '';

      if (kalshiLabelSlug && polyQuestion.toLowerCase().includes(kalshiLabelSlug)) {
        pairs.push({
          eventName: rightEvent.title,
          canonicalEventId: rightEvent.id,
          canonicalMarketId: polyMarket.id,
          label: kalshiYes.label,
          kalshiTicker: kalshiMarket.providers.kalshi?.ticker,
          polymarketConditionId: polyMarket.providers.polymarket?.marketId,
          polymarketSlug: polyMarket.providers.polymarket?.slug,
          polymarketYesTokenId: polyYes.providers.polymarket?.tokenId,
        });
        break;
      }
    }
  }

  const outputPath = path.join(__dirname, '..', 'scripts', 'prediction_market_event_pairs.json');
  fs.writeFileSync(outputPath, JSON.stringify(pairs, null, 2) + '\n', 'utf8');

  console.log(`Wrote ${pairs.length} entries to ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

