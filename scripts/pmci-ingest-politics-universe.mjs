#!/usr/bin/env node
/**
 * Politics universe ingestion (PMCI Phase 1). Thin CLI wrapper around lib/ingestion/universe.mjs.
 * Env: DATABASE_URL, PMCI_POLITICS_KALSHI_SERIES_TICKERS, PMCI_POLITICS_POLY_TAG_ID, etc.
 * Pass --reset to ignore Kalshi checkpoint and start fresh.
 */

import { loadEnv } from "../src/platform/env.mjs";
import { runUniverseIngest } from "../lib/ingestion/universe.mjs";

loadEnv();

runUniverseIngest({ reset: process.argv.includes("--reset") })
  .then((result) => {
    console.log(result.summary);
    process.exit(result.ok ? 0 : 1);
  })
  .catch((err) => {
    console.error("pmci:politics:universe FAIL:", err.message);
    process.exit(1);
  });
