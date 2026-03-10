import test from "node:test";
import assert from "node:assert/strict";
import {
  percentile,
  typeFactor,
  computeConsensus,
  computeDivergence,
} from "../../src/utils/metrics.mjs";

test("percentile returns null for empty input", () => {
  assert.equal(percentile([], 95), null);
});

test("percentile computes expected p95", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 95), 5);
  assert.equal(percentile([5, 1, 3, 4, 2], 50), 3);
});

test("typeFactor maps relationship types", () => {
  assert.equal(typeFactor("identical"), 1);
  assert.equal(typeFactor("equivalent"), 1);
  assert.equal(typeFactor("proxy"), 0.5);
  assert.equal(typeFactor("correlated"), 0.25);
  assert.equal(typeFactor("other"), 0.25);
});

test("computeConsensus uses active links with weighted averages", () => {
  const links = [
    { status: "active", provider_market_id: 1, confidence: 1, relationship_type: "equivalent" },
    { status: "active", provider_market_id: 2, confidence: 1, relationship_type: "proxy" },
    { status: "inactive", provider_market_id: 3, confidence: 1, relationship_type: "equivalent" },
  ];
  const latestByMarketId = new Map([
    [1, { price_yes: 0.6, liquidity: 10 }],
    [2, { price_yes: 0.2, liquidity: 10 }],
    [3, { price_yes: 0.9, liquidity: 10 }],
  ]);

  const c = computeConsensus(links, latestByMarketId);
  // weights: 10*1*1 + 10*1*0.5 = 15; numerator: 6 + 1 = 7
  assert.equal(c, 7 / 15);
});

test("computeDivergence handles nulls and absolute difference", () => {
  assert.equal(computeDivergence(null, 0.5), null);
  assert.equal(computeDivergence(0.9, null), null);
  assert.equal(computeDivergence(0.9, 0.4), 0.5);
});
