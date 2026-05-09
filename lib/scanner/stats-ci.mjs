/**
 * Wilson score interval for binomial proportion (used for hit-rate bootstrapped-style CI in reports).
 * @param {number} successes
 * @param {number} n
 * @param {number} [z]
 * @returns {{ low: number, high: number }}
 */
export function wilsonInterval(successes, n, z = 1.96) {
  if (!Number.isFinite(successes) || !Number.isFinite(n) || n <= 0) {
    return { low: 0, high: 1 };
  }
  const cappedS = Math.min(Math.max(successes, 0), n);
  const p = cappedS / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const adj = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: Math.max(0, centre - adj), high: Math.min(1, centre + adj) };
}

/** Interval straddles 0.5 → ambiguous vs random (design §2 marker). */
export function intervalStraddlesHalf(interval) {
  return interval.low <= 0.5 && interval.high >= 0.5;
}
