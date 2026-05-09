/**
 * River-compatible Kolmogorov–Smirnov Windowing (KSWIN) drift detector (1-D stream).
 * Reference: river.drift.KSWIN + Raab et al., Neurocomputing 2020.
 */

import { ksTwoSamplePValue, ksTwoSampleStatistic, ksPermutationPValue } from "./ks.mjs";

/**
 * @param {number} seed
 */
function mulberry32(seed) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sample `k` distinct integers from [0, maxExclusive)
 *
 * @param {() => number} rng01
 * @param {number} maxExclusive
 * @param {number} k
 */
function sampleIndicesWithoutReplacement(rng01, maxExclusive, k) {
  const pool = [];
  for (let i = 0; i < maxExclusive; i++) pool.push(i);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng01() * (pool.length - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, k);
}

export class KSWIN {
  /**
   * @param {{ alpha?: number; windowSize?: number; statSize?: number; seed?: number }} opts
   */
  constructor(opts = {}) {
    const alpha = opts.alpha ?? 0.005;
    const windowSize = opts.windowSize ?? 100;
    const statSize = opts.statSize ?? 30;
    const seed = opts.seed ?? 42;
    if (alpha <= 0 || alpha > 1) throw new Error("KSWIN: alpha must be in (0,1]");
    if (windowSize < statSize * 2) {
      throw new Error("KSWIN: windowSize must be >= 2 * statSize");
    }
    this.alpha = alpha;
    this.windowSize = windowSize;
    this.statSize = statSize;
    this.seed = seed;
    this._hardReset();
  }

  _hardReset() {
    this.drift_detected = false;
    /** @type {number[]} */
    this.window = [];
    this.p_value = 1;
    this.n = 0;
    this._rng = mulberry32(this.seed >>> 0);
    this._permRng = mulberry32(((this.seed ^ 0xdeadbeef) >>> 0) || 1);
  }

  /**
   * @param {number} x
   */
  update(x) {
    if (this.drift_detected) {
      this._hardReset();
    }
    this.n += 1;
    this.window.push(x);
    if (this.window.length > this.windowSize) this.window.shift();

    if (this.window.length >= this.windowSize) {
      const headLen = this.windowSize - this.statSize;
      const idxs = sampleIndicesWithoutReplacement(this._rng, headLen, this.statSize);
      const rndWindow = idxs.map((i) => this.window[i]);
      const mostRecent = this.window.slice(this.windowSize - this.statSize, this.windowSize);
      const st = ksTwoSampleStatistic(rndWindow, mostRecent);
      const vals = rndWindow.concat(mostRecent);
      const binaryOnly = vals.every((z) => z === 0 || z === 1);
      const pv = binaryOnly
        ? ksPermutationPValue(rndWindow, mostRecent, 140, this._permRng)
        : ksTwoSamplePValue(st, rndWindow.length, mostRecent.length);
      this.p_value = pv;
      if (pv <= this.alpha && st > 0.1) {
        this.drift_detected = true;
        this.window = mostRecent.slice();
      } else {
        this.drift_detected = false;
      }
    } else {
      this.drift_detected = false;
    }
    return this;
  }
}
