import test from "node:test";
import assert from "node:assert/strict";
import { ksTwoSampleStatistic, ksPermutationPValue } from "../../../lib/scanner/decay/ks.mjs";

test("KS statistic separates disjoint samples", () => {
  const a = Array.from({ length: 60 }, (_, i) => i * 0.01);
  const b = Array.from({ length: 60 }, (_, i) => 5 + i * 0.01);
  const d = ksTwoSampleStatistic(a, b);
  assert.ok(d > 0.95);
});

test("permutation p-value is tiny for disjoint binary samples", () => {
  function lcg(seed) {
    let s = seed >>> 0;
    return () => {
      s = (1664525 * s + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  const a = Array(22).fill(1);
  const b = Array(22).fill(0);
  const pv = ksPermutationPValue(a, b, 80, lcg(777));
  assert.ok(pv < 0.05);
});
