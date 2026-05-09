/**
 * Avellaneda–Stoikov reservation price + half-spread (binary quoting; §5.3 mm-runtime-redesign-v2).
 * Units: mid in cents (1–99); sigma in probability units per sqrt(year) style scale used for binaries.
 */

/**
 * Reservation price in cents: r = mid - q * gamma * sigma^2 * tau (mid in prob space).
 *
 * @param {number} midCents
 * @param {number} q signed inventory (YES contracts)
 * @param {number} gamma risk aversion > 0
 * @param {number} sigma volatility > 0
 * @param {number} tau time to settle as fraction of day > 0
 * @returns {number}
 */
export function reservationPriceCents(midCents, q, gamma, sigma, tau) {
  const mid = Number(midCents);
  const g = Number(gamma);
  const s = Number(sigma);
  const t = Number(tau);
  const qq = Number(q);
  if (!Number.isFinite(mid) || !Number.isFinite(qq)) return NaN;
  if (!(g > 0) || !(s > 0) || !(t > 0)) return NaN;
  const S = mid / 100;
  const r = S - qq * g * s * s * t;
  return r * 100;
}

/**
 * A-S half-spread in probability units; multiply by 100 for cents if mid is cents scale.
 *
 * @param {{ gamma: number, sigma: number, kappa: number, tau: number }} p
 * @returns {number}
 */
export function computeHalfSpreadProbUnits(p) {
  const gamma = Number(p.gamma);
  const sigma = Number(p.sigma);
  const kappa = Number(p.kappa);
  const tau = Number(p.tau);
  if (!(gamma > 0) || !(sigma > 0) || !(kappa > 0) || !(tau > 0)) return NaN;
  return gamma * sigma * sigma * tau + (2 / gamma) * Math.log(1 + gamma / kappa);
}

/** Half-spread in cents (same order of magnitude as legacy min_half_spread). */
export function computeHalfSpreadCents(state) {
  const hu = computeHalfSpreadProbUnits(state);
  if (!Number.isFinite(hu)) return NaN;
  return hu * 100;
}

/**
 * Realized volatility proxy from mid-price series (cents). Clamped into binary band [0.05, 0.15].
 *
 * @param {number[]} midCentsSeries oldest → newest
 * @returns {number}
 */
export function sigmaEstimatorFromMidCentsSeries(midCentsSeries) {
  const xs = Array.isArray(midCentsSeries) ? midCentsSeries.map(Number).filter((x) => Number.isFinite(x)) : [];
  if (xs.length < 3) return 0.1;
  const p = xs.map((c) => Math.min(0.99, Math.max(0.01, c / 100)));
  let sumSq = 0;
  let n = 0;
  for (let i = 1; i < p.length; i++) {
    const a = Math.log(p[i] / (1 - p[i]));
    const b = Math.log(p[i - 1] / (1 - p[i - 1]));
    const d = a - b;
    sumSq += d * d;
    n += 1;
  }
  const raw = n > 0 ? Math.sqrt(sumSq / n) : 0.1;
  const scaled = Math.min(0.25, Math.max(0.02, raw * 0.35));
  return Math.min(0.15, Math.max(0.05, scaled));
}
