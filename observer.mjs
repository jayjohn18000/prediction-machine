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
import { loadEnv } from './src/platform/env.mjs';
import { createClient } from '@supabase/supabase-js';
import { createPmciClient, getProviderIds } from './lib/pmci-ingestion.mjs';
import { runObserverCycle } from './lib/ingestion/observer-cycle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv();

const PMCI_DEBUG = process.env.PMCI_DEBUG === '1';
const USE_PMXT = process.env.USE_PMXT === '1'; // spike flag — see docs/pmxt-spike-result.md when ready

/** Canonical config; do not use root event_pairs.json. */
const DEFAULT_PAIRS_PATH = path.join(__dirname, 'scripts', 'prediction_market_event_pairs.json');
const DEFAULT_INTERVAL_SEC = 60;

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

async function main() {
  const { pairs } = loadConfig();
  const supabase = getSupabase();
  const intervalSec = parseInt(process.env.SPREAD_OBSERVER_INTERVAL_SEC || String(DEFAULT_INTERVAL_SEC), 10) || DEFAULT_INTERVAL_SEC;

  const pmciRetryState = {
    attempts: 0,
    maxAttempts: Number(process.env.PMCI_INGESTION_MAX_RETRIES ?? '3'),
    lastAttemptAt: null,
    permanentlyDisabled: false,
  };

  const pmciClientRef = { value: createPmciClient() };
  const pmciIdsRef = { value: null };
  if (pmciClientRef.value) {
    try {
      await pmciClientRef.value.connect();
      pmciIdsRef.value = await getProviderIds(pmciClientRef.value);
      if (!pmciIdsRef.value?.kalshi || !pmciIdsRef.value?.polymarket) {
        console.warn('PMCI ingestion disabled: pmci.providers missing kalshi or polymarket. Run migrations.');
        pmciClientRef.value
          .end()
          .catch(() => {})
          .finally(() => {
            pmciClientRef.value = null;
            pmciIdsRef.value = null;
          });
      } else {
        console.log('PMCI ingestion enabled (DATABASE_URL set, provider IDs resolved by code).');
      }
    } catch (err) {
      console.warn('PMCI ingestion disabled: could not connect:', err.message);
      pmciClientRef.value
        .end()
        .catch(() => {})
        .finally(() => {
          pmciClientRef.value = null;
          pmciIdsRef.value = null;
        });
    }
  }
  const pmciReport = pmciClientRef.value ? { marketsUpserted: 0, snapshotsAppended: 0 } : null;

  console.log(`Prediction market spread observer started. Pairs: ${pairs.length}, interval: ${intervalSec}s`);

  const run = () =>
    runObserverCycle({
      pairs,
      supabase,
      pmciClientRef,
      pmciReport,
      pmciIdsRef,
      pmciRetryState,
    }).catch((err) => console.error('Cycle error:', err));

  await run();
  const intervalId = setInterval(run, intervalSec * 1000);

  const shutdown = () => {
    clearInterval(intervalId);
    if (pmciClientRef.value) pmciClientRef.value.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
