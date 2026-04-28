import test from "node:test";
import assert from "node:assert/strict";
import { blendKalshiPolyMid, updateFairValue, emaHalfLifeStep, HALF_LIFE_MS } from "../../lib/mm/fair-value.mjs";

test("blendKalshiPolyMid R16 mixes with liquidity weights", () => {
  const v = blendKalshiPolyMid(48, 60, 2, 1);
  assert.equal(Math.round(v * 1000), Math.round(((48 * 2 + 60 * 1) / 3) * 1000));
});

test("blendKalshiPolyMid Kalshi-only path", () => {
  assert.equal(blendKalshiPolyMid(55, null, null, null), 55);
});

test("emaHalfLifeStep cold-start seeds blended mid", () => {
  const s = emaHalfLifeStep({}, 40, 10_000, 1000);
  assert.equal(s.emaCents, 40);
  assert.ok((s.confidence ?? 0) > 0);
});

test("updateFairValue produces fair_value_cents and carry", () => {
  const r = updateFairValue({
    state: {},
    midKalshiCents: 52,
    nowMs: 20_000,
    midObservedMs: 19_500,
  });
  assert.ok(Number.isFinite(r.fair_value_cents));
  assert.ok(r.carry);
});

test("HALF_LIFE_MS is 30s (R15)", () => {
  assert.equal(HALF_LIFE_MS, 30_000);
});
