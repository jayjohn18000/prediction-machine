#!/usr/bin/env node
/**
 * Prediction Market Spread Observer (data capture v1) — observation-only.
 *
 * Fetches YES prices from Kalshi and Polymarket per config, computes spread,
 * inserts rows into Supabase prediction_market_spreads. Endpoint discovery by
 * verification; no hardcoded API bases. Append-only storage.
 *
 * Config: single source of truth is scripts/prediction_market_event_pairs.json.
 * Override with SPREAD_EVENT_PAIRS_PATH if needed. Each pair: eventName,
 * kalshiTicker, polymarketSlug, polymarketOutcomeName.
 *
 * Env:
 *   SUPABASE_URL                    – Supabase project URL (required)
 *   SUPABASE_ANON_KEY               – Supabase anon or service key (required)
 *   SPREAD_EVENT_PAIRS_PATH         – Config JSON path (optional override)
 *   SPREAD_OBSERVER_INTERVAL_SEC    – Seconds between cycles (default: 60)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const KALSHI_BASES = [
  'https://api.elections.kalshi.com/trade-api/v2',
  'https://api.kalshi.com/trade-api/v2',
];
const POLYMARKET_BASES = ['https://gamma-api.polymarket.com'];

/** Canonical config; do not use root event_pairs.json. */
const DEFAULT_PAIRS_PATH = path.join(__dirname, 'scripts', 'prediction_market_event_pairs.json');
const DEFAULT_INTERVAL_SEC = 60;

let kalshiBase = null;
let polymarketBase = null;

function loadConfig() {
  const pairsPath = process.env.SPREAD_EVENT_PAIRS_PATH || DEFAULT_PAIRS_PATH;
  let raw;
  try {
    raw = fs.readFileSync(pairsPath, 'utf8');
  } catch (err) {
    console.error(`Error: could not read event pairs config at ${pairsPath}:`, err.message);
    process.exit(1);
  }
  let pairs;
  try {
    pairs = JSON.parse(raw);
  } catch (err) {
    console.error(`Error: invalid JSON in event pairs config:`, err.message);
    process.exit(1);
  }
  if (!Array.isArray(pairs) || pairs.length === 0) {
    console.error('Error: event pairs config must be a non-empty array of { eventName, kalshiTicker, polymarketSlug, polymarketOutcomeName }');
    process.exit(1);
  }
  for (const p of pairs) {
    if (!p || typeof p.eventName !== 'string' || typeof p.kalshiTicker !== 'string' || typeof p.polymarketSlug !== 'string' || typeof p.polymarketOutcomeName !== 'string') {
      console.error('Error: each pair must have eventName, kalshiTicker, polymarketSlug, polymarketOutcomeName (strings)');
      process.exit(1);
    }
  }
  return { pairs, pairsPath };
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Error: SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY) are required');
    process.exit(1);
  }
  return createClient(url, key);
}

/** One Kalshi request per cycle: fetch markets for event (limit 1000). Returns { map, ok }. Map: ticker -> { yesBid, yesAsk, yes, openInterest, volume24h }. */
async function fetchAllKalshiPrices(base, eventTicker) {
  const map = new Map();
  const url = `${base}/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Kalshi HTTP ${res.status} for event ${eventTicker}`);
    kalshiBase = null;
    return { map, ok: false };
  }
  const data = await res.json().catch(() => null);
  const page = data?.markets;
  if (Array.isArray(page)) {
    for (const m of page) {
      const ticker = m?.ticker;
      const yesAsk = parseNum(m?.yes_ask_dollars ?? m?.last_price_dollars);
      const yesBid = parseNum(m?.yes_bid_dollars);
      if (!ticker || (yesAsk == null && yesBid == null)) continue;
      const yes = yesAsk ?? yesBid;
      if (yes == null || yes < 0 || yes > 1) continue;
      map.set(ticker, {
        yesBid: yesBid != null && yesBid >= 0 && yesBid <= 1 ? yesBid : null,
        yesAsk: yesAsk != null && yesAsk >= 0 && yesAsk <= 1 ? yesAsk : null,
        yes,
        openInterest: parseNum(m?.open_interest ?? m?.open_interest_fp),
        volume24h: parseNum(m?.volume_24h ?? m?.volume_24h_fp),
      });
    }
  }
  return { map, ok: true };
}

function parseNum(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

/** One Polymarket request per cycle: fetch event by slug, return event data (or null). */
async function fetchPolymarketEvent(base, slug) {
  const url = `${base}/events/slug/${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Polymarket HTTP ${res.status} for slug ${slug}`);
    polymarketBase = null;
    return null;
  }
  return res.json().catch(() => null);
}

/** Build outcomeName -> { yes, bestBid, bestAsk } from Polymarket event data and config pairs (match by question). */
function buildPolymarketPriceMap(eventData, pairs) {
  const map = new Map();
  const markets = eventData?.markets;
  if (!Array.isArray(markets)) return map;
  for (const m of markets) {
    let outcomePricesArr = m?.outcomePrices;
    if (typeof outcomePricesArr === 'string') {
      try {
        outcomePricesArr = JSON.parse(outcomePricesArr);
      } catch {
        continue;
      }
    }
    if (!Array.isArray(outcomePricesArr) || outcomePricesArr.length === 0) continue;
    const raw = outcomePricesArr[0];
    const yes = typeof raw === 'number' ? raw : parseFloat(raw);
    if (Number.isNaN(yes) || yes < 0 || yes > 1) continue;
    const question = m?.question;
    if (typeof question !== 'string') continue;
    const bestBid = parseNum(m?.bestBid);
    const bestAsk = parseNum(m?.bestAsk);
    for (const p of pairs) {
      if (question.includes(p.polymarketOutcomeName)) {
        map.set(p.polymarketOutcomeName, {
          yes,
          bestBid: bestBid != null && bestBid >= 0 && bestBid <= 1 ? bestBid : null,
          bestAsk: bestAsk != null && bestAsk >= 0 && bestAsk <= 1 ? bestAsk : null,
        });
        break;
      }
    }
  }
  return map;
}

function isPriceValid(value) {
  if (value == null || Number.isNaN(value)) return false;
  const n = Number(value);
  return n >= 0 && n <= 1;
}

function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}

/** Group pairs by (Kalshi event ticker base, Polymarket slug) for multi-event cycles. */
function groupPairsByEvent(pairs) {
  const groups = new Map();
  for (const p of pairs) {
    const eventTicker = p.kalshiTicker.replace(/-[^-]+$/, '');
    const slug = p.polymarketSlug;
    const key = `${eventTicker}\t${slug}`;
    if (!groups.has(key)) groups.set(key, { eventTicker, slug, pairs: [] });
    groups.get(key).pairs.push(p);
  }
  return [...groups.values()];
}

async function runOneCycleForEvent(eventTicker, slug, pairs, supabase) {
  if (pairs.length === 0) return;

  let kalshiMap;
  if (kalshiBase) {
    const r = await fetchAllKalshiPrices(kalshiBase, eventTicker);
    if (!r.ok) {
      kalshiBase = null;
      return;
    }
    kalshiMap = r.map;
  } else {
    for (const base of KALSHI_BASES) {
      const r = await fetchAllKalshiPrices(base, eventTicker);
      if (r.ok) {
        kalshiBase = base;
        kalshiMap = r.map;
        console.log(`Kalshi endpoint verified: ${base}`);
        break;
      }
    }
  }
  if (!kalshiMap) {
    console.error('Kalshi: no event data for', eventTicker);
    return;
  }

  let polymarketData = null;
  if (polymarketBase) {
    polymarketData = await fetchPolymarketEvent(polymarketBase, slug);
  }
  if (!polymarketData?.markets?.length) {
    polymarketBase = null;
    for (const base of POLYMARKET_BASES) {
      polymarketData = await fetchPolymarketEvent(base, slug);
      if (polymarketData?.markets?.length) {
        polymarketBase = base;
        console.log(`Polymarket endpoint verified: ${base}`);
        break;
      }
    }
  }
  if (!polymarketData?.markets?.length) {
    console.error('Polymarket: no event data for slug', slug);
    return;
  }

  const polymarketMap = buildPolymarketPriceMap(polymarketData, pairs);
  const observedAt = new Date().toISOString();

  for (const pair of pairs) {
    const k = kalshiMap.get(pair.kalshiTicker);
    const pm = polymarketMap.get(pair.polymarketOutcomeName);
    const kalshiYes = k?.yes;
    const polymarketYes = pm?.yes;

    if (!isPriceValid(kalshiYes)) {
      console.error(`Price sanity: skipping "${pair.eventName}" – kalshi_yes invalid: ${kalshiYes}`);
      continue;
    }
    if (!isPriceValid(polymarketYes)) {
      console.error(`Price sanity: skipping "${pair.eventName}" – polymarket_yes invalid: ${polymarketYes}`);
      continue;
    }

    const spread = round4(Number(kalshiYes) - Number(polymarketYes));
    const row = {
      event_id: pair.polymarketSlug,
      candidate: pair.polymarketOutcomeName,
      kalshi_yes: round4(Number(kalshiYes)),
      polymarket_yes: round4(Number(polymarketYes)),
      spread,
      observed_at: observedAt,
      source_meta: { kalshi_ticker: pair.kalshiTicker, polymarket_slug: pair.polymarketSlug },
      kalshi_yes_bid: k?.yesBid != null ? round4(k.yesBid) : null,
      kalshi_yes_ask: k?.yesAsk != null ? round4(k.yesAsk) : null,
      kalshi_open_interest: k?.openInterest != null ? k.openInterest : null,
      kalshi_volume_24h: k?.volume24h != null ? k.volume24h : null,
      polymarket_yes_bid: pm?.bestBid != null ? round4(pm.bestBid) : null,
      polymarket_yes_ask: pm?.bestAsk != null ? round4(pm.bestAsk) : null,
    };

    const { error } = await supabase.from('prediction_market_spreads').insert(row);
    if (error) {
      console.error(`Supabase insert error for ${pair.polymarketOutcomeName}:`, error.message);
      continue;
    }
    console.log(`OK candidate=${pair.polymarketOutcomeName} spread=${spread}`);
  }
}

async function runOneCycle(pairs, supabase) {
  if (pairs.length === 0) return;
  const eventGroups = groupPairsByEvent(pairs);
  for (const { eventTicker, slug, pairs: eventPairs } of eventGroups) {
    await runOneCycleForEvent(eventTicker, slug, eventPairs, supabase);
  }
}

async function main() {
  const { pairs } = loadConfig();
  const supabase = getSupabase();
  const intervalSec = parseInt(process.env.SPREAD_OBSERVER_INTERVAL_SEC || String(DEFAULT_INTERVAL_SEC), 10) || DEFAULT_INTERVAL_SEC;

  console.log(`Prediction market spread observer started. Pairs: ${pairs.length}, interval: ${intervalSec}s`);

  const run = () => runOneCycle(pairs, supabase).catch((err) => console.error('Cycle error:', err));

  await run();
  const intervalId = setInterval(run, intervalSec * 1000);

  const shutdown = () => {
    clearInterval(intervalId);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
