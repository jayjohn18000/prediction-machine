/**
 * Polymarket provider HTTP fetch + outcome parsing.
 * Exposes a helper that returns outcomeName -> price map for an event slug.
 */
import { retry, fetchWithTimeout } from "../retry.mjs";

export const POLYMARKET_BASES = ["https://gamma-api.polymarket.com"];

let polymarketBase = null;

function parseNum(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

async function fetchPolymarketEvent(base, slug) {
  const url = `${base}/events/slug/${encodeURIComponent(slug)}`;
  const res = await retry(
    () => fetchWithTimeout(url, {}, 10_000),
    { maxAttempts: 2, baseDelayMs: 800 }
  );
  if (!res.ok) {
    console.error(`Polymarket HTTP ${res.status} for slug ${slug}`);
    return null;
  }
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function buildPolymarketPriceMap(eventData, pairs) {
  const map = new Map();
  let jsonParseErrors = 0;
  const markets = eventData?.markets;
  if (!Array.isArray(markets)) return { map, jsonParseErrors };

  for (const m of markets) {
    let outcomePricesArr = m?.outcomePrices;
    if (typeof outcomePricesArr === "string") {
      try {
        outcomePricesArr = JSON.parse(outcomePricesArr);
      } catch {
        jsonParseErrors += 1;
        continue;
      }
    }
    if (!Array.isArray(outcomePricesArr) || outcomePricesArr.length === 0) continue;
    const raw = outcomePricesArr[0];
    const yes = typeof raw === "number" ? raw : parseFloat(raw);
    if (Number.isNaN(yes) || yes < 0 || yes > 1) continue;
    const question = m?.question;
    if (typeof question !== "string") continue;
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

  return { map, jsonParseErrors };
}

/**
 * Fetch prices for all Polymarket outcomes relevant to the provided pairs.
 */
export async function fetchPolymarketPriceMap(slug, pairs) {
  let eventData = null;

  if (polymarketBase) {
    eventData = await fetchPolymarketEvent(polymarketBase, slug);
  }
  if (!eventData?.markets?.length) {
    polymarketBase = null;
    for (const base of POLYMARKET_BASES) {
      eventData = await fetchPolymarketEvent(base, slug);
      if (eventData?.markets?.length) {
        polymarketBase = base;
        console.log(`Polymarket endpoint verified: ${base}`);
        break;
      }
    }
  }
  if (!eventData?.markets?.length) {
    console.error("Polymarket: no event data for slug", slug);
    return { map: new Map(), ok: false, jsonParseErrors: 0 };
  }

  const { map, jsonParseErrors } = buildPolymarketPriceMap(eventData, pairs);
  return { map, ok: true, jsonParseErrors };
}

/**
 * Fetch raw event data by slug using the same sticky-base logic as fetchPolymarketPriceMap.
 * Returns the parsed event JSON (with .markets array) or null on failure.
 */
export async function fetchPolymarketEventData(slug) {
  if (polymarketBase) {
    const d = await fetchPolymarketEvent(polymarketBase, slug);
    if (d?.markets?.length) return d;
    polymarketBase = null;
  }
  for (const base of POLYMARKET_BASES) {
    const d = await fetchPolymarketEvent(base, slug);
    if (d?.markets?.length) {
      polymarketBase = base;
      return d;
    }
  }
  return null;
}

