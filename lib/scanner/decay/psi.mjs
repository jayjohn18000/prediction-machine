/**
 * Population Stability Index (bucketed; Frouros-style discrete PSI).
 */

/**
 * @param {number[]} refValues
 * @param {number[]} curValues
 * @param {number} buckets
 * @returns {number|null} null if no comparable finite values
 */
export function computePsi(refValues, curValues, buckets = 10) {
  const refFin = refValues.filter(Number.isFinite);
  const curFin = curValues.filter(Number.isFinite);
  const all = [...refFin, ...curFin];
  if (all.length === 0) return null;
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  if (lo === hi) return 0;

  /** @param {number[]} vals */
  function hist(vals) {
    const counts = new Array(buckets).fill(0);
    for (const v of vals) {
      if (!Number.isFinite(v)) continue;
      let b = Math.floor(((v - lo) / (hi - lo)) * buckets);
      if (b >= buckets) b = buckets - 1;
      if (b < 0) b = 0;
      counts[b]++;
    }
    return counts;
  }

  const hr = hist(refFin);
  const hc = hist(curFin);
  const nr = refFin.length || 1;
  const nc = curFin.length || 1;
  const eps = 1e-12;
  let psi = 0;
  for (let i = 0; i < buckets; i++) {
    const rp = hr[i] / nr;
    const cp = hc[i] / nc;
    psi += (cp - rp) * Math.log((cp + eps) / (rp + eps));
  }
  return psi;
}
