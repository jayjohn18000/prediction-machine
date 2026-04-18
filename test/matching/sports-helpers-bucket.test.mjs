import test from "node:test";
import assert from "node:assert/strict";
import { classifyMarketTypeBucket } from "../../lib/matching/sports-helpers.mjs";

test("totals: classic o/u wording", () => {
  assert.equal(classifyMarketTypeBucket("Game totals over/under 8.5"), "totals");
  assert.equal(classifyMarketTypeBucket("O/U 5.5"), "totals");
});

test("totals: team run line (baseball)", () => {
  assert.equal(classifyMarketTypeBucket("Will Minnesota score over 4.5 runs?"), "totals");
  assert.equal(classifyMarketTypeBucket("Will New York Y score under 3.5 runs?"), "totals");
  assert.equal(classifyMarketTypeBucket("Kansas City wins by over 2.5 runs?"), "totals");
});

test("moneyline: not swallowed by totals", () => {
  assert.equal(classifyMarketTypeBucket("Who will win: Lakers vs Celtics?"), "moneyline_winner");
});

test("spread still detected", () => {
  assert.equal(classifyMarketTypeBucket("Spread -3.5 Lakers"), "spread");
});
