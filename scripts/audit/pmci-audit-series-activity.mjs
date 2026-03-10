#!/usr/bin/env node
/**
 * PMCI D0 — Series activity audit. For each configured Kalshi series ticker,
 * calls GET /trade-api/v2/events?series_ticker={ticker}&status=open and prints
 * event count. No reliance on external overlap tables.
 * Env: PMCI_POLITICS_KALSHI_SERIES_TICKERS (comma-separated)
 */

import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

const KALSHI_BASES = [
  "https://api.elections.kalshi.com/trade-api/v2",
  "https://api.kalshi.com/trade-api/v2",
];

function splitCsv(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function fetchEventsForSeries(base, seriesTicker) {
  const url = `${base}/events?series_ticker=${encodeURIComponent(seriesTicker)}&status=open&limit=200`;
  const res = await fetch(url);
  if (!res.ok) return { ok: false, count: 0, status: res.status };
  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, count: 0, status: "parse_error" };
  }
  const events = Array.isArray(data?.events) ? data.events : [];
  let total = events.length;
  let cursor = data?.cursor ?? data?.next_cursor;
  while (cursor && total < 10000) {
    const nextUrl = `${base}/events?series_ticker=${encodeURIComponent(seriesTicker)}&status=open&limit=200&cursor=${encodeURIComponent(cursor)}`;
    const r = await fetch(nextUrl);
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const page = Array.isArray(d?.events) ? d.events : [];
    total += page.length;
    cursor = d?.cursor ?? d?.next_cursor ?? null;
  }
  return { ok: true, count: total, status: res.status };
}

async function main() {
  const tickers = splitCsv(process.env.PMCI_POLITICS_KALSHI_SERIES_TICKERS);
  if (tickers.length === 0) {
    console.error("PMCI_POLITICS_KALSHI_SERIES_TICKERS is not set or empty.");
    process.exit(1);
  }

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

  console.log("ticker | event_count | status");
  console.log("-------|-------------|--------");

  let live = 0;
  for (const ticker of tickers) {
    const { ok, count, status } = await fetchEventsForSeries(base, ticker);
    const statusStr = ok ? "ok" : String(status);
    console.log(`${ticker} | ${count} | ${statusStr}`);
    if (count > 0) live += 1;
  }

  console.log("");
  console.log(`Summary: ${live} live / ${tickers.length} total configured`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
