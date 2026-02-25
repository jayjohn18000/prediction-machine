#!/usr/bin/env node
/**
 * Discover 2028 Republican nominee candidates that exist on BOTH Kalshi and Polymarket.
 * No ticker guessing: Kalshi tickers and candidate names come from APIs only.
 * Merges GOP pairs into scripts/prediction_market_event_pairs.json (canonical config).
 * Does not overwrite existing Democratic pairs. Dedupes by (kalshiTicker, polymarketSlug, polymarketOutcomeName).
 *
 * Usage: node scripts/discover-gop-2028-dual-listings.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const POLYMARKET_BASE = 'https://gamma-api.polymarket.com';
const KALSHI_EVENT_TICKER = 'KXPRESNOMR-28';
const POLYMARKET_SLUG = 'republican-presidential-nominee-2028';

/** Normalize for deterministic matching: trim, collapse spaces, lowercase. */
function normalizeName(s) {
  if (typeof s !== 'string') return '';
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Fetch all Kalshi markets for the event (paginated). */
async function fetchKalshiMarkets() {
  const out = [];
  let cursor = '';
  let page;
  do {
    const url = new URL(`${KALSHI_BASE}/markets`);
    url.searchParams.set('event_ticker', KALSHI_EVENT_TICKER);
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Kalshi HTTP ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    page = data?.markets;
    if (!Array.isArray(page)) break;
    out.push(...page);
    cursor = data?.cursor ?? '';
  } while (cursor && page.length > 0);
  return out;
}

/** Build map: normalized name -> { ticker, canonicalName } from Kalshi. Use API names only. */
function buildKalshiMap(markets) {
  const map = new Map();
  for (const m of markets) {
    const ticker = m?.ticker;
    const name = m?.yes_sub_title ?? m?.custom_strike?.Candidate ?? m?.no_sub_title ?? '';
    if (!ticker || typeof name !== 'string' || !name.trim()) continue;
    const normalized = normalizeName(name);
    if (!normalized) continue;
    map.set(normalized, { ticker, canonicalName: name.trim() });
  }
  return map;
}

/** Fetch Polymarket event by slug. */
async function fetchPolymarketEvent() {
  const url = `${POLYMARKET_BASE}/events/slug/${encodeURIComponent(POLYMARKET_SLUG)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Polymarket HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/** Extract candidate name from Republican market question. */
function extractCandidateFromQuestion(question) {
  if (typeof question !== 'string') return null;
  const m =
    question.match(/Will (.+?) be (?:the )?nominee for the Presidency for the Republican/) ||
    question.match(/Will (.+?) be (?:the )?Republican/) ||
    question.match(/Will (.+?) win/);
  return m ? m[1].trim() : null;
}

/** Build map: normalized name -> exact outcome name for Polymarket. Only active markets. */
function buildPolymarketMap(eventData) {
  const markets = eventData?.markets;
  const map = new Map();
  if (!Array.isArray(markets)) return map;
  for (const m of markets) {
    if (m?.active === false) continue;
    const question = m?.question;
    const name = extractCandidateFromQuestion(question);
    if (!name) continue;
    const normalized = normalizeName(name);
    if (!normalized) continue;
    map.set(normalized, name);
  }
  return map;
}

async function main() {
  console.log('Fetching Kalshi markets (Republican 2028)...');
  const kalshiMarkets = await fetchKalshiMarkets();
  const kalshiMap = buildKalshiMap(kalshiMarkets);
  console.log(`Kalshi: ${kalshiMarkets.length} markets, ${kalshiMap.size} unique candidate names`);

  console.log('Fetching Polymarket event (republican-presidential-nominee-2028)...');
  const polymarketEvent = await fetchPolymarketEvent();
  const polymarketMap = buildPolymarketMap(polymarketEvent);
  const pmMarkets = polymarketEvent?.markets?.length ?? 0;
  console.log(`Polymarket: ${pmMarkets} markets, ${polymarketMap.size} active candidate names`);

  const foundBoth = [];
  const kalshiOnly = [];
  const polymarketOnly = [];

  for (const [normalized, { ticker, canonicalName }] of kalshiMap) {
    const polyName = polymarketMap.get(normalized);
    if (polyName) {
      foundBoth.push({
        eventName: `Republican nominee 2028 - ${canonicalName}`,
        kalshiTicker: ticker,
        polymarketSlug: POLYMARKET_SLUG,
        polymarketOutcomeName: polyName,
      });
    } else {
      kalshiOnly.push(canonicalName);
    }
  }
  for (const [normalized, name] of polymarketMap) {
    if (!kalshiMap.has(normalized)) polymarketOnly.push(name);
  }

  console.log('\n--- Candidates found on BOTH ---');
  foundBoth.forEach((e) => console.log(`  ${e.polymarketOutcomeName}  (${e.kalshiTicker})`));
  if (kalshiOnly.length) {
    console.log('\n--- On Kalshi only (not on Polymarket) ---');
    kalshiOnly.slice(0, 15).forEach((n) => console.log(`  ${n}`));
    if (kalshiOnly.length > 15) console.log(`  ... and ${kalshiOnly.length - 15} more`);
  }
  if (polymarketOnly.length) {
    console.log('\n--- On Polymarket only (not on Kalshi) ---');
    polymarketOnly.slice(0, 15).forEach((n) => console.log(`  ${n}`));
    if (polymarketOnly.length > 15) console.log(`  ... and ${polymarketOnly.length - 15} more`);
  }

  const canonicalPath = path.join(ROOT, 'scripts', 'prediction_market_event_pairs.json');
  let existing = [];
  try {
    const raw = fs.readFileSync(canonicalPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) existing = parsed;
  } catch (err) {
    console.warn('Could not read existing', canonicalPath, err.message);
  }

  const key = (p) => `${p.kalshiTicker}|${p.polymarketSlug}|${p.polymarketOutcomeName}`;
  const seen = new Set(existing.map(key));
  const toAdd = foundBoth.filter((p) => !seen.has(key(p)));
  const merged = [...existing, ...toAdd];

  // Deduplicate by (kalshiTicker, polymarketSlug, polymarketOutcomeName)
  const deduped = [];
  const seenFinal = new Set();
  for (const p of merged) {
    const k = key(p);
    if (seenFinal.has(k)) continue;
    seenFinal.add(k);
    deduped.push(p);
  }

  fs.writeFileSync(canonicalPath, JSON.stringify(deduped, null, 2) + '\n', 'utf8');

  const byEventId = deduped.reduce((acc, p) => {
    const e = p.polymarketSlug;
    acc[e] = (acc[e] || 0) + 1;
    return acc;
  }, {});

  console.log('\n--- Merge result ---');
  console.log('Canonical config:', canonicalPath);
  console.log('GOP pairs appended:', toAdd.length);
  console.log('Total pairs:', deduped.length);
  console.log('By event_id:', byEventId);
  console.log('Duplicates removed:', merged.length - deduped.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
