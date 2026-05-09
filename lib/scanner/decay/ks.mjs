/**
 * Two-sample Kolmogorov–Smirnov statistic + asymptotic p-value (NR-style probks).
 */

/**
 * @param {number} alam
 */
function kolmogorovSF(alam) {
  const eps1 = 1e-8;
  const eps2 = 1e-50;
  let fac = 2;
  let sum = 0;
  let termbf = 0;
  const a2 = -2 * alam * alam;
  for (let j = 1; j <= 100; j++) {
    const term = fac * Math.exp(a2 * j * j);
    sum += term;
    if (Math.abs(term) <= eps1 * termbf || Math.abs(term) <= eps2 * Math.abs(sum)) break;
    fac = -fac;
    termbf = Math.abs(term);
  }
  return Math.min(1, Math.max(0, 2 * sum));
}

/**
 * KS D statistic for two one-dimensional samples.
 *
 * @param {number[]} sample1
 * @param {number[]} sample2
 * @returns {number}
 */
export function ksTwoSampleStatistic(sample1, sample2) {
  const a = sample1.filter(Number.isFinite).slice().sort((x, y) => x - y);
  const b = sample2.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (a.length === 0 || b.length === 0) return 0;
  let i = 0;
  let j = 0;
  let fa = 0;
  let fb = 0;
  let d = 0;
  while (i < a.length && j < b.length) {
    const x = Math.min(a[i], b[j]);
    while (i < a.length && a[i] <= x) {
      i++;
      fa = i / a.length;
    }
    while (j < b.length && b[j] <= x) {
      j++;
      fb = j / b.length;
    }
    d = Math.max(d, Math.abs(fa - fb));
  }
  return d;
}

/**
 * Asymptotic two-sample KS p-value (two-sided), scipy-compatible enough for KSWIN.
 *
 * @param {number} d observed statistic
 * @param {number} n first sample size (finite values used when computing D)
 * @param {number} m second sample size
 * @returns {number}
 */
export function ksTwoSamplePValue(d, n, m) {
  if (n <= 0 || m <= 0 || !Number.isFinite(d)) return 1;
  const en = Math.sqrt((n * m) / (n + m));
  const lam = en * d;
  return kolmogorovSF(lam);
}

/**
 * Monte Carlo two-sample KS p-value (two-sided). Reliable for sparse / discrete streams.
 *
 * @param {number[]} sample1
 * @param {number[]} sample2
 * @param {number} rounds
 * @param {() => number} rng01
 */
export function ksPermutationPValue(sample1, sample2, rounds, rng01) {
  const d0 = ksTwoSampleStatistic(sample1, sample2);
  const n = sample1.length;
  const m = sample2.length;
  const pool = sample1.concat(sample2);
  let ge = 0;
  for (let r = 0; r < rounds; r++) {
    const shuffled = pool.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng01() * (i + 1));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
    const d = ksTwoSampleStatistic(shuffled.slice(0, n), shuffled.slice(n));
    if (d >= d0 - 1e-12) ge++;
  }
  return (ge + 1) / (rounds + 1);
}
