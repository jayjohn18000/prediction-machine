/**
 * VPIN + trade history helper for orchestrator.
 */

import { computeVpin, shouldPullQuotes, vpinPullDurationMs } from "../toxicity/vpin.mjs";

/**
 * Map mm_fills rows → VPIN trades (YES buy = buy, YES sell = sell).
 *
 * @param {Array<{ side: string, size_contracts: unknown }>} rows
 */
export function fillsToVpinTrades(rows) {
  /** @type {import('../toxicity/vpin.mjs').VpinTrade[]} */
  const out = [];
  for (const r of rows) {
    const sz = Math.abs(Number(r.size_contracts) || 0);
    if (sz <= 0) continue;
    const s = String(r.side ?? "");
    if (s === "yes_buy") out.push({ side: "buy", size: sz });
    else if (s === "yes_sell") out.push({ side: "sell", size: sz });
  }
  return out.reverse();
}

/**
 * @param {import('../toxicity/vpin.mjs').VpinTrade[]} trades chronological oldest→newest
 */
export function evaluateVpinPull(trades, threshold, bucketSize = 30, windowBuckets = 10) {
  const v = computeVpin(trades, bucketSize, windowBuckets);
  const pull = shouldPullQuotes(v, threshold);
  return { vpin: v, pull, bucketSize, windowBuckets };
}

export function markVpinPullUntil(pullUntilByTicker, ticker, nowMs = Date.now()) {
  pullUntilByTicker[ticker] = nowMs + vpinPullDurationMs();
}

export function isVpinPullActive(pullUntilByTicker, ticker, nowMs = Date.now()) {
  const until = pullUntilByTicker[ticker];
  return until != null && nowMs < until;
}
