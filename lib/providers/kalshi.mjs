/**
 * Kalshi provider HTTP fetch + price normalization.
 * Exposes a single helper that returns a ticker -> price map for an event.
 */
import { retry, fetchWithTimeout } from "../retry.mjs";

/** Canonical Trade API host only — legacy api.kalshi.com intermittently fails DNS on Fly (ENOTFOUND) and aborted full observer cycles after 429 clears sticky base. */
export const KALSHI_BASES = ["https://api.elections.kalshi.com/trade-api/v2"];

let kalshiBase = null;

function parseNum(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

async function fetchAllKalshiPrices(base, eventTicker) {
  const map = new Map();
  const url = `${base}/markets?event_ticker=${encodeURIComponent(
    eventTicker
  )}&limit=1000`;
  let res;
  try {
    res = await retry(
      () => fetchWithTimeout(url, {}, 15_000),
      { maxAttempts: 2, baseDelayMs: 800 }
    );
  } catch (err) {
    const msg = err?.cause?.message ?? err?.message ?? String(err);
    console.error(`Kalshi fetch network error for event ${eventTicker}:`, msg);
    return { map, ok: false, jsonParseErrors: 0 };
  }
  if (!res.ok) {
    console.error(`Kalshi HTTP ${res.status} for event ${eventTicker}`);
    return { map, ok: false, jsonParseErrors: 0 };
  }
  let data = null;
  let jsonParseErrors = 0;
  try {
    data = await res.json();
  } catch {
    jsonParseErrors = 1;
  }
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
  return { map, ok: true, jsonParseErrors };
}

/**
 * Fetch prices for all Kalshi markets in an event.
 * Maintains a sticky base URL across calls for efficiency while still
 * probing alternatives when necessary.
 */
export async function fetchKalshiPriceMap(eventTicker) {
  let jsonParseErrors = 0;

  if (kalshiBase) {
    const r = await fetchAllKalshiPrices(kalshiBase, eventTicker);
    jsonParseErrors += r.jsonParseErrors ?? 0;
    if (!r.ok) {
      kalshiBase = null;
      return { map: r.map, ok: false, jsonParseErrors };
    }
    return { map: r.map, ok: true, jsonParseErrors };
  }

  for (const base of KALSHI_BASES) {
    const r = await fetchAllKalshiPrices(base, eventTicker);
    jsonParseErrors += r.jsonParseErrors ?? 0;
    if (r.ok) {
      kalshiBase = base;
      console.log(`Kalshi endpoint verified: ${base}`);
      return { map: r.map, ok: true, jsonParseErrors };
    }
  }

  console.error("Kalshi: no event data for", eventTicker);
  return { map: new Map(), ok: false, jsonParseErrors };
}

