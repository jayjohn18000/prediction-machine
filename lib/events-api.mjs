import { mapKalshiEventToCanonical } from './providers/kalshi-adapter.mjs';
import { mapPolymarketEventToCanonical } from './providers/polymarket-adapter.mjs';

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const POLYMARKET_BASE = 'https://gamma-api.polymarket.com';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

/**
 * List canonical events for Kalshi by event_ticker.
 * This is a minimal initial integration surface; it can be extended
 * later to support broader filters (categories, date ranges, etc.).
 *
 * @param {{ eventTicker: string }} filters
 * @returns {Promise<import('./events-schema.mjs').CanonicalEvent[]>}
 */
export async function listKalshiEvents(filters) {
  const eventTicker = filters.eventTicker;
  if (!eventTicker) return [];

  const eventUrl = new URL(`${KALSHI_BASE}/events`);
  eventUrl.searchParams.set('event_ticker', eventTicker);
  eventUrl.searchParams.set('with_nested_markets', 'false');

  const eventResp = await fetchJson(eventUrl.toString());
  const event = Array.isArray(eventResp?.events) && eventResp.events[0];
  if (!event) return [];

  const seriesUrl = `${KALSHI_BASE}/series/${encodeURIComponent(event.series_ticker)}`;
  const series = await fetchJson(seriesUrl);

  const marketsUrl = new URL(`${KALSHI_BASE}/markets`);
  marketsUrl.searchParams.set('event_ticker', eventTicker);
  marketsUrl.searchParams.set('limit', '1000');
  const marketsResp = await fetchJson(marketsUrl.toString());
  const markets = Array.isArray(marketsResp?.markets) ? marketsResp.markets : [];

  return [mapKalshiEventToCanonical({ event, series, markets })];
}

/**
 * List canonical events for Polymarket by event slug.
 *
 * @param {{ slug: string }} filters
 * @returns {Promise<import('./events-schema.mjs').CanonicalEvent[]>}
 */
export async function listPolymarketEvents(filters) {
  const slug = filters.slug;
  if (!slug) return [];

  const eventUrl = `${POLYMARKET_BASE}/events/slug/${encodeURIComponent(slug)}`;
  const event = await fetchJson(eventUrl);
  const markets = Array.isArray(event?.markets) ? event.markets : [];

  return [mapPolymarketEventToCanonical({ event, markets })];
}

/**
 * List markets for a canonical event.
 *
 * @param {import('./events-schema.mjs').CanonicalEvent} canonicalEvent
 * @returns {import('./events-schema.mjs').CanonicalMarket[]}
 */
export function listMarkets(canonicalEvent) {
  return canonicalEvent.markets.slice();
}

