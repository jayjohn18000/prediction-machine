#!/usr/bin/env node
/**
 * Discover 2028 Democratic nominee candidates that exist on BOTH Kalshi and Polymarket.
 * No ticker guessing: Kalshi tickers and candidate names come from APIs only.
 * Output: scripts/prediction_market_event_pairs.json (validated config for observer).
 *
 * Usage: node scripts/discover-dem-2028-dual-listings.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const POLYMARKET_BASE = 'https://gamma-api.polymarket.com';
const KALSHI_EVENT_TICKER = 'KXPRESNOMD-28';
const POLYMARKET_SLUG = 'democratic-presidential-nominee-2028';

const CANDIDATE_NAMES = [
  'Gavin Newsom',
  'Alexandria Ocasio-Cortez',
  'Jon Ossoff',
  'Josh Shapiro',
  'Kamala Harris',
  'J.B. Pritzker',
  'Pete Buttigieg',
  'Andy Beshear',
  'Gretchen Whitmer',
  'Mark Kelly',
  'Wes Moore',
  'Jon Stewart',
  'Rahm Emanuel',
  'Ruben Gallego',
  'Ro Khanna',
  'Stephen A. Smith',
  'Cory Booker',
  'Chris Murphy',
  'James Talarico',
  'Raphael Warnock',
  'Zohran Mamdani',
  'Barack Obama',
  'Bernie Sanders',
  'Dwayne Johnson',
  'Gina Raimondo',
  'Hunter Biden',
  'Hillary Clinton',
  'John Fetterman',
  'Jared Polis',
  'Liz Cheney',
  'LeBron James',
  'Mark Cuban',
  'Michelle Obama',
  'Phil Murphy',
  'Roy Cooper',
  'Tim Walz',
];

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

/** Extract candidate name from a market question. "Will X be the Democratic..." -> X. */
function extractCandidateFromQuestion(question) {
  if (typeof question !== 'string') return null;
  const m = question.match(/Will (.+?) be (?:the )?Democratic/) || question.match(/Will (.+?) win/);
  return m ? m[1].trim() : null;
}

/** Build map: normalized name -> exact outcome name (as in question) for Polymarket. Only active markets. */
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

/** Find best match for input name in a map keyed by normalized name. Returns canonical value or null. */
function findInMap(inputName, map) {
  const n = normalizeName(inputName);
  return map.get(n) ?? null;
}

async function main() {
  console.log('Fetching Kalshi markets...');
  const kalshiMarkets = await fetchKalshiMarkets();
  const kalshiMap = buildKalshiMap(kalshiMarkets);
  console.log(`Kalshi: ${kalshiMarkets.length} markets, ${kalshiMap.size} unique candidate names`);

  console.log('Fetching Polymarket event...');
  const polymarketEvent = await fetchPolymarketEvent();
  const polymarketMap = buildPolymarketMap(polymarketEvent);
  const pmMarkets = polymarketEvent?.markets?.length ?? 0;
  console.log(`Polymarket: ${pmMarkets} markets, ${polymarketMap.size} active candidate names`);

  const foundBoth = [];
  const missingKalshi = [];
  const missingPolymarket = [];

  for (const candidateName of CANDIDATE_NAMES) {
    const k = findInMap(candidateName, kalshiMap);
    const p = findInMap(candidateName, polymarketMap);
    if (k && p) {
      foundBoth.push({
        eventName: `Democratic nominee 2028 - ${k.canonicalName}`,
        kalshiTicker: k.ticker,
        polymarketSlug: POLYMARKET_SLUG,
        polymarketOutcomeName: p,
      });
    } else if (!k) {
      missingKalshi.push(candidateName);
    } else {
      missingPolymarket.push(candidateName);
    }
  }

  console.log('\n--- Candidates found on BOTH ---');
  foundBoth.forEach((e) => console.log(`  ${e.polymarketOutcomeName}  (${e.kalshiTicker})`));
  console.log('\n--- Candidates missing on Kalshi ---');
  missingKalshi.forEach((n) => console.log(`  ${n}`));
  console.log('\n--- Candidates missing on Polymarket ---');
  missingPolymarket.forEach((n) => console.log(`  ${n}`));

  const outputPath = path.join(__dirname, 'prediction_market_event_pairs.json');
  fs.writeFileSync(outputPath, JSON.stringify(foundBoth, null, 2) + '\n', 'utf8');
  console.log(`\nWrote ${foundBoth.length} entries to ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
