/**
 * Pure price/outcome parsing utilities for ingestion pipelines.
 * No I/O, no side effects — safe to import anywhere.
 */

export function parseNum(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

export function clamp01(n) {
  if (n == null || Number.isNaN(n)) return null;
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(1, x));
}

export function parseOutcomes(m) {
  let out = m?.outcomes ?? m?.outcomeNames ?? null;
  if (typeof out === "string") {
    try {
      out = JSON.parse(out);
    } catch {
      out = null;
    }
  }
  if (!Array.isArray(out)) return null;
  return out.map((o) => String(o));
}

export function parseOutcomePrices(m) {
  let arr = m?.outcomePrices ?? m?.outcome_prices ?? m?.prices ?? null;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch {
      arr = null;
    }
  }
  if (!Array.isArray(arr)) return null;
  return arr
    .map((x) => {
      if (x == null) return null;
      const n = typeof x === "number" ? x : parseFloat(x);
      return clamp01(n);
    })
    .map((x) => (typeof x === "number" && !Number.isNaN(x) ? x : null));
}

export function getDerivedPrice(m) {
  const bestBid = parseNum(m?.bestBid ?? m?.best_bid);
  const bestAsk = parseNum(m?.bestAsk ?? m?.best_ask);
  if (bestBid != null && bestAsk != null) {
    const mid = (bestBid + bestAsk) / 2;
    const clamped = clamp01(mid);
    if (clamped != null) return { price: clamped, source: "mid" };
  }
  const lastTrade = parseNum(m?.lastTradePrice ?? m?.last_trade_price);
  if (lastTrade != null) {
    const clamped = clamp01(lastTrade);
    if (clamped != null) return { price: clamped, source: "lastTradePrice" };
  }
  return null;
}
