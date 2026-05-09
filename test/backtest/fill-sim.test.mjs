import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateFill, simulateMakerTouchFill, simulateTakerCross } from "../../lib/backtest/fill-sim.mjs";

test("simulateMakerTouchFill conservative requires extra cent through bid", () => {
  const o = { mmSide: "yes_buy", priceCents: 50, size: 2 };
  assert.equal(simulateMakerTouchFill(o, 51, 50, true), null);
  const f = simulateMakerTouchFill(o, 51, 49, true);
  assert.ok(f);
  assert.equal(f?.priceCents, 50);
});

test("simulateTakerCross buys at ask", () => {
  const o = { mmSide: "yes_buy", size: 1 };
  const f = simulateTakerCross(o, { bestBidCents: 48, bestAskCents: 52 });
  assert.ok(f);
  assert.equal(f?.priceCents, 52);
  assert.equal(f?.maker, false);
});

test("simulateFill dispatches kind", () => {
  const maker = simulateFill(
    { kind: "maker", mmSide: "yes_sell", priceCents: 60, size: 1, prevMidCents: 59, curMidCents: 61 },
    {},
    true,
  );
  assert.ok(maker);
});
