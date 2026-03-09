#!/usr/bin/env node
/**
 * PMCI D1 — Discover Kalshi series not in config. Option A: GET /series?category=politics.
 * Option B (fallback): heuristic ticker construction (state × race type × year), rate-limited.
 * Output: PMCI_POLITICS_KALSHI_SERIES_TICKERS=<tickers> for human review; do not write .env.
 * Env: KALSHI_DISCOVERY_CACHE_PATH (optional, for Option B cache)
 */

import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "../src/platform/env.mjs";

loadEnv();

const KALSHI_BASES = [
  "https://api.elections.kalshi.com/trade-api/v2",
  "https://api.kalshi.com/trade-api/v2",
];

const US_STATE_CODES = [
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc",
];

const RACE_PREFIXES = ["GOVPARTY", "SENATE", "PRES", "HOUSE", "AG"];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function trySeriesListApi(base) {
  const url = `${base}/series?category=politics`;
  const res = await fetch(url);
  if (!res.ok) return null;
  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  const list = Array.isArray(data?.series) ? data.series : [];
  return list.map((s) => s?.ticker).filter(Boolean);
}

async function probeSeriesOpenEvents(base, seriesTicker) {
  const url = `${base}/events?series_ticker=${encodeURIComponent(seriesTicker)}&status=open&limit=1`;
  const res = await fetch(url);
  if (!res.ok) return false;
  let data;
  try {
    data = await res.json();
  } catch {
    return false;
  }
  const events = Array.isArray(data?.events) ? data.events : [];
  return events.length > 0;
}

async function main() {
  let base = null;
  for (const b of KALSHI_BASES) {
    try {
      const r = await fetch(`${b}/events?limit=1`);
      if (r.ok) {
        base = b;
        break;
      }
    } catch (_) {}
  }
  if (!base) {
    console.error("Kalshi API unreachable.");
    process.exit(1);
  }

  let discovered = [];

  const fromApi = await trySeriesListApi(base);
  if (fromApi != null && fromApi.length > 0) {
    console.error("Using Option A: GET /series?category=politics");
    discovered = fromApi;
  } else {
    console.error("Option A failed or empty; using Option B: heuristic probe.");
    const cachePath = process.env.KALSHI_DISCOVERY_CACHE_PATH
      ? path.resolve(process.cwd(), process.env.KALSHI_DISCOVERY_CACHE_PATH)
      : null;
    let cache = {};
    if (cachePath) {
      try {
        const raw = fs.readFileSync(cachePath, "utf8");
        cache = JSON.parse(raw);
      } catch (_) {}
    }

    const year = new Date().getFullYear();
    const years = [year, year + 1, year + 2, year + 3];
    const candidates = [];

    for (const prefix of RACE_PREFIXES) {
      if (prefix === "PRES") {
        for (const y of years) candidates.push(`PRES-${y}`);
        continue;
      }
      if (prefix === "GOVPARTY" || prefix === "SENATE" || prefix === "AG") {
        for (const state of US_STATE_CODES) {
          for (const y of years) {
            candidates.push(`${prefix}-${state.toUpperCase()}-${y}`);
          }
        }
        continue;
      }
      if (prefix === "HOUSE") {
        for (const state of US_STATE_CODES) {
          for (const y of years) {
            candidates.push(`HOUSE-${state.toUpperCase()}-01-${y}`);
          }
        }
      }
    }

    const rateLimitMs = 500;
    for (let i = 0; i < candidates.length; i++) {
      const ticker = candidates[i];
      if (cache[ticker] !== undefined) {
        if (cache[ticker]) discovered.push(ticker);
        continue;
      }
      const live = await probeSeriesOpenEvents(base, ticker);
      cache[ticker] = live;
      if (live) discovered.push(ticker);
      if ((i + 1) % 50 === 0) console.error(`Probed ${i + 1}/${candidates.length}...`);
      await sleep(rateLimitMs);
    }

    if (cachePath) {
      try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify(cache, null, 0), "utf8");
      } catch (e) {
        console.warn("Could not write cache:", e.message);
      }
    }
  }

  const govOrSenate = discovered.filter(
    (t) => t.startsWith("GOVPARTY-") || t.startsWith("SENATE-")
  );
  if (govOrSenate.length < 2) {
    console.warn("Hard gate D1: need at least 2 GOVPARTY-* or SENATE-* in discovered output. Found:", govOrSenate.length);
  }

  const line = discovered.length > 0
    ? `PMCI_POLITICS_KALSHI_SERIES_TICKERS=${discovered.join(",")}`
    : "# No series discovered; leave PMCI_POLITICS_KALSHI_SERIES_TICKERS unset or as-is.";
  console.log(line);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
