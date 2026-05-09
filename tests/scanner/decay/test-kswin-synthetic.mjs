import test from "node:test";
import assert from "node:assert/strict";
import { KSWIN } from "../../../lib/scanner/decay/kswin.mjs";

/**
 * Deterministic PRNG in [0,1)
 * @param {number} seed
 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("KSWIN fires after Bernoulli regime shift (0.62 → 0.28)", () => {
  const rng = lcg(424242);
  function bern(p) {
    return rng() < p ? 1 : 0;
  }

  const kswin = new KSWIN({
    alpha: 0.05,
    windowSize: 72,
    statSize: 24,
    seed: 999,
  });

  let firedAt = -1;
  let idx = 0;

  for (; idx < 50; idx++) {
    kswin.update(bern(0.62));
  }
  for (; idx < 140; idx++) {
    kswin.update(bern(0.28));
    if (kswin.drift_detected) {
      firedAt = idx;
      break;
    }
  }

  assert.ok(
    firedAt >= 0,
    `expected streaming drift alarm after regime shift (last p=${kswin.p_value})`,
  );
});
