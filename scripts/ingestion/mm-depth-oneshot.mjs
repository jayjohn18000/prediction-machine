#!/usr/bin/env node
/**
 * MM MVP W1 — one-shot demo WS run against Kalshi demo.
 *
 * Usage:
 *   node scripts/ingestion/mm-depth-oneshot.mjs [--duration-sec=30]
 *
 * Env (required; live in .env, not auto-written):
 *   KALSHI_DEMO_API_KEY_ID
 *   KALSHI_DEMO_PRIVATE_KEY_PATH (or KALSHI_DEMO_PRIVATE_KEY inline PEM)
 *   KALSHI_DEMO_WS_URL                   (e.g. wss://demo-api.kalshi.co/trade-api/ws/v2)
 *   KALSHI_DEMO_UNIVERSE_TICKERS         comma-separated Kalshi ticker list
 *   SUPABASE_URL, SUPABASE_ANON_KEY      (or DATABASE_URL for direct pg)
 *
 * What it does:
 *   1. Loads the configured ticker universe.
 *   2. Resolves each ticker to a pmci.provider_markets.id via a Supabase lookup.
 *      Tickers not found in provider_markets are reported and skipped (does not
 *      abort — useful for demo-universe scouting where demo may surface tickers
 *      that aren't in our prod-mirroring DB).
 *   3. Connects to the Kalshi demo WebSocket, subscribes, streams depth for
 *      --duration-sec seconds (default 30), writes 1Hz rows to
 *      pmci.provider_market_depth.
 *   4. After disconnect, SELECT-counts rows inserted per market and prints the
 *      summary so you can eyeball the verification-step-4 check.
 *
 * This script is INTENDED for manual W1 verification. It does NOT run on cron.
 * Do not merge a cron entry for this without converting it to a long-running
 * service first (which is the job of lib/mm/orchestrator.mjs in W3+).
 */

import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "../../src/platform/env.mjs";
import { loadPrivateKey } from "../../lib/providers/kalshi-ws-auth.mjs";
import { startDepthIngestion } from "../../lib/ingestion/depth.mjs";

loadEnv();

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([a-z0-9-]+)=(.+)$/i);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const durationSec = Number(args["duration-sec"] ?? 30);

  const keyId = process.env.KALSHI_DEMO_API_KEY_ID;
  const privateKeyPath = process.env.KALSHI_DEMO_PRIVATE_KEY_PATH;
  const privateKeyInline = process.env.KALSHI_DEMO_PRIVATE_KEY;
  const wsUrl = process.env.KALSHI_DEMO_WS_URL || "wss://demo-api.kalshi.co/trade-api/ws/v2";
  const universe = (process.env.KALSHI_DEMO_UNIVERSE_TICKERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const missing = [];
  if (!keyId) missing.push("KALSHI_DEMO_API_KEY_ID");
  if (!privateKeyPath && !privateKeyInline) {
    missing.push("KALSHI_DEMO_PRIVATE_KEY_PATH or KALSHI_DEMO_PRIVATE_KEY");
  }
  if (universe.length === 0) missing.push("KALSHI_DEMO_UNIVERSE_TICKERS");
  if (!process.env.SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!process.env.SUPABASE_ANON_KEY) missing.push("SUPABASE_ANON_KEY");

  if (missing.length > 0) {
    console.error("FAIL: missing env vars:");
    for (const m of missing) console.error("  -", m);
    console.error("See .env.example for the W1 Kalshi demo entries.");
    process.exit(1);
  }

  const privateKey = loadPrivateKey({ path: privateKeyPath, inline: privateKeyInline });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

  // Resolve tickers → provider_market_ids.
  console.log(`mm-depth-oneshot: resolving ${universe.length} ticker(s) against pmci.provider_markets...`);
  const { data: rows, error: resolveErr } = await supabase
    .schema("pmci")
    .from("provider_markets")
    .select("id, provider_market_ref")
    .eq("provider_id", 1)
    .in("provider_market_ref", universe);

  if (resolveErr) {
    console.error("FAIL: provider_markets lookup failed:", resolveErr.message);
    process.exit(1);
  }

  const tickerToProviderMarketId = new Map();
  for (const r of rows || []) {
    tickerToProviderMarketId.set(r.provider_market_ref, r.id);
  }

  const resolved = universe.filter((t) => tickerToProviderMarketId.has(t));
  const unresolved = universe.filter((t) => !tickerToProviderMarketId.has(t));
  console.log(`  resolved: ${resolved.length}/${universe.length}`);
  if (unresolved.length > 0) {
    console.warn("  UNRESOLVED (skipped):", unresolved.join(", "));
    console.warn(
      "  These tickers exist in demo but not in our prod-mirroring DB. To scout demo-only, " +
      "omit the DB insert step — for W1 this is acceptable; you'll still see WS messages logged.",
    );
  }

  if (resolved.length === 0) {
    console.error("FAIL: no universe tickers resolved to provider_market_ids. Cannot write rows.");
    console.error("Either: (a) add these tickers to provider_markets via observer ingest, or");
    console.error("(b) scout-only mode without DB writes — not implemented in this script for W1.");
    process.exit(1);
  }

  console.log(`mm-depth-oneshot: connecting to ${wsUrl} ...`);
  const { stop, books } = await startDepthIngestion({
    marketTickers: resolved,
    tickerToProviderMarketId,
    wsUrl,
    apiKeyId: keyId,
    privateKey,
    supabase,
    downsampleIntervalMs: 1000,
    logger: console,
  });

  console.log(`mm-depth-oneshot: streaming for ${durationSec}s ...`);
  await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));

  console.log("mm-depth-oneshot: stopping...");
  stop();

  // Give pending writes a brief moment to flush.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Summary: count rows per market inserted in the last (durationSec + 5) seconds.
  const since = new Date(Date.now() - (durationSec + 5) * 1000).toISOString();
  const results = [];
  for (const ticker of resolved) {
    const pmid = tickerToProviderMarketId.get(ticker);
    const { count, error } = await supabase
      .schema("pmci")
      .from("provider_market_depth")
      .select("*", { count: "exact", head: true })
      .eq("provider_market_id", pmid)
      .gte("observed_at", since);
    if (error) {
      console.warn(`  ${ticker}: count lookup failed: ${error.message}`);
    } else {
      results.push({ ticker, pmid, rows_inserted: count ?? 0 });
    }
  }

  console.log("\n=== W1 verification summary ===");
  console.log(`Duration: ${durationSec}s   Downsample: 1Hz   Expected rows/market: ~${durationSec}`);
  for (const r of results) {
    const flag = r.rows_inserted > 0 ? "OK" : "EMPTY";
    console.log(`  [${flag}] ${r.ticker} (pmid=${r.pmid}): ${r.rows_inserted} rows`);
  }
  const anyEmpty = results.some((r) => r.rows_inserted === 0);
  const anyPopulated = results.some((r) => r.rows_inserted > 0);
  console.log("");
  console.log(anyPopulated ? "At least one market streamed rows — depth.mjs plumbing verified." : "No rows inserted — investigate auth, WS URL, or ticker-in-demo mismatch.");
  if (anyEmpty) {
    console.log("Some markets had zero rows — likely thin books or demo not streaming those tickers. Not necessarily a failure.");
  }

  process.exit(anyPopulated ? 0 : 1);
}

main().catch((err) => {
  console.error("FAIL:", err?.stack || err);
  process.exit(1);
});
