/**
 * Volume-Synchronized Probability of Informed Trading (VPIN-style imbalance).
 * Pure buckets over volume — port of the small jheusser/vpin-style core.
 */

/**
 * @typedef {{ side: 'buy' | 'sell', size: number }} VpinTrade
 */

/**
 * @param {VpinTrade[]} trades chronological
 * @param {number} bucketSize cumulative volume per bucket
 * @returns {Array<{ buys: number, sells: number }>}
 */
export function bucketByVolume(trades, bucketSize) {
  const bs = Math.max(30, Number(bucketSize) || 30);
  /** @type {Array<{ buys: number, sells: number }>} */
  const out = [];
  let b = 0;
  let s = 0;
  let acc = 0;
  for (const t of trades) {
    const sz = Math.max(0, Number(t?.size) || 0);
    if (sz <= 0) continue;
    let rest = sz;
    while (rest > 0) {
      const room = bs - acc;
      const take = Math.min(room, rest);
      if (t.side === "buy") b += take;
      else s += take;
      acc += take;
      rest -= take;
      if (acc >= bs) {
        out.push({ buys: b, sells: s });
        b = 0;
        s = 0;
        acc = 0;
      }
    }
  }
  if (acc > 0) out.push({ buys: b, sells: s });
  return out;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, x) => a + x, 0) / arr.length;
}

/**
 * @param {VpinTrade[]} trades
 * @param {number} bucketSize
 * @param {number} windowBuckets
 */
export function computeVpin(trades, bucketSize, windowSize) {
  const buckets = bucketByVolume(trades, bucketSize);
  const w = Math.max(1, Math.floor(Number(windowSize) || 1));
  const recent = buckets.slice(-w);
  if (!recent.length) return 0;
  const oi = recent.map((b) => Math.abs(b.buys - b.sells) / Math.max(30, Number(bucketSize) || 30));
  return mean(oi);
}

export function shouldPullQuotes(vpin, threshold = 0.7) {
  return Number(vpin) > Number(threshold);
}

/** Pull duration in ms (spec: 60s). */
export function vpinPullDurationMs() {
  return 60_000;
}
