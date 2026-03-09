import test from "node:test";
import assert from "node:assert/strict";
import {
  parseNum,
  clamp01,
  parseOutcomes,
  parseOutcomePrices,
  getDerivedPrice,
} from "../../lib/ingestion/services/price-parsers.mjs";

test("parseNum", (t) => {
  assert.equal(parseNum(0.5), 0.5);
  assert.equal(parseNum("0.75"), 0.75);
  assert.equal(parseNum(null), null);
  assert.equal(parseNum(""), null);
  assert.equal(parseNum("bad"), null);
  assert.equal(parseNum(undefined), null);
  assert.equal(parseNum(0), 0);
});

test("clamp01", (t) => {
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(0), 0);
  assert.equal(clamp01(1), 1);
  assert.equal(clamp01(1.5), 1);
  assert.equal(clamp01(-0.1), 0);
  assert.equal(clamp01(null), null);
  assert.equal(clamp01(NaN), null);
  assert.equal(clamp01(Infinity), null);
});

test("parseOutcomes — array input", (t) => {
  assert.deepEqual(parseOutcomes({ outcomes: ["Yes", "No"] }), ["Yes", "No"]);
  assert.deepEqual(parseOutcomes({ outcomeNames: ["A", "B"] }), ["A", "B"]);
  assert.equal(parseOutcomes({}), null);
  assert.equal(parseOutcomes(null), null);
});

test("parseOutcomes — JSON string input", (t) => {
  assert.deepEqual(parseOutcomes({ outcomes: '["Yes","No"]' }), ["Yes", "No"]);
  assert.equal(parseOutcomes({ outcomes: "not-json" }), null);
});

test("parseOutcomePrices — array input", (t) => {
  assert.deepEqual(parseOutcomePrices({ outcomePrices: [0.7, 0.3] }), [0.7, 0.3]);
  assert.deepEqual(parseOutcomePrices({ outcome_prices: ["0.5", "0.5"] }), [0.5, 0.5]);
  assert.deepEqual(parseOutcomePrices({ prices: [1.5, -0.1] }), [1, 0]);
  assert.equal(parseOutcomePrices({}), null);
});

test("parseOutcomePrices — JSON string input", (t) => {
  assert.deepEqual(parseOutcomePrices({ outcomePrices: "[0.6,0.4]" }), [0.6, 0.4]);
  assert.equal(parseOutcomePrices({ outcomePrices: "bad" }), null);
});

test("getDerivedPrice — mid from bid/ask", (t) => {
  const result = getDerivedPrice({ bestBid: 0.4, bestAsk: 0.6 });
  assert.deepEqual(result, { price: 0.5, source: "mid" });
});

test("getDerivedPrice — fallback to lastTradePrice", (t) => {
  const result = getDerivedPrice({ lastTradePrice: 0.55 });
  assert.deepEqual(result, { price: 0.55, source: "lastTradePrice" });
});

test("getDerivedPrice — null when no price data", (t) => {
  assert.equal(getDerivedPrice({}), null);
  assert.equal(getDerivedPrice(null), null);
});

test("getDerivedPrice — clamps mid to [0,1]", (t) => {
  const result = getDerivedPrice({ bestBid: 0.9, bestAsk: 1.5 });
  assert.deepEqual(result, { price: 1, source: "mid" });
});
