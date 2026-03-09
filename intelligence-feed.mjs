#!/usr/bin/env node
/**
 * Executable-edge intelligence feed — runs continuously.
 *
 * Polls the executable_edges_feed view (observations where
 * kalshi_yes_bid > polymarket_yes_ask) and prints the raw execution
 * intelligence. Same data will power the first API endpoint later.
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_ANON_KEY  – required
 *   INTELLIGENCE_FEED_INTERVAL_SEC   – seconds between polls (default: 30)
 */

import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './src/platform/env.mjs';
loadEnv();

const DEFAULT_INTERVAL_SEC = 30;
const FEED_LIMIT = 200;

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Error: SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY) are required');
    process.exit(1);
  }
  return createClient(url, key);
}

async function fetchFeed(supabase) {
  const { data, error } = await supabase
    .from('executable_edges_feed')
    .select('candidate, kalshi_yes_bid, polymarket_yes_ask, executable_edge, observed_at')
    .order('observed_at', { ascending: false })
    .limit(FEED_LIMIT);
  if (error) throw error;
  return data || [];
}

function formatRow(r) {
  const at = r.observed_at ? new Date(r.observed_at).toISOString() : '';
  const edge = r.executable_edge != null ? Number(r.executable_edge).toFixed(4) : '';
  return `${at}  ${(r.candidate || '').padEnd(24)}  kalshi_bid=${r.kalshi_yes_bid}  pm_ask=${r.polymarket_yes_ask}  edge=${edge}`;
}

async function runOnce(supabase) {
  const rows = await fetchFeed(supabase);
  const now = new Date().toISOString();
  console.log(`\n--- executable_edges_feed @ ${now} (${rows.length} rows) ---`);
  if (rows.length === 0) {
    console.log('(no executable edges)');
    return;
  }
  rows.forEach((r) => console.log(formatRow(r)));
}

async function main() {
  const supabase = getSupabase();
  const intervalSec = parseInt(process.env.INTELLIGENCE_FEED_INTERVAL_SEC || String(DEFAULT_INTERVAL_SEC), 10) || DEFAULT_INTERVAL_SEC;

  console.log(`Intelligence feed started. Polling executable_edges_feed every ${intervalSec}s.`);

  const run = () => runOnce(supabase).catch((err) => console.error('Feed error:', err.message));

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
