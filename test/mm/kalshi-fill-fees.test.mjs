import test from "node:test";
import assert from "node:assert/strict";
import { observedFeesFromKalshiFill } from "../../lib/mm/kalshi-fill-fees.mjs";

test("observedFees: explicit trade_fee_dollars wins", () => {
  const r = observedFeesFromKalshiFill({
    fee_cost: "0.0100",
    trade_fee_dollars: "0.0070",
    rebate_dollars: "0.0020",
    is_taker: true,
  });
  assert.equal(r.kalshi_net_fee_cents, 1);
  assert.ok(Math.abs(r.kalshi_trade_fee_cents - 0.7) < 1e-9);
  assert.ok(Math.abs(r.kalshi_rebate_cents - 0.2) < 1e-9);
});

test("observedFees: taker derives trade from fee_cost when no breakdown", () => {
  const r = observedFeesFromKalshiFill({
    fee_cost: "0.0150",
    is_taker: true,
  });
  assert.equal(r.kalshi_net_fee_cents, 1.5);
  assert.equal(r.kalshi_trade_fee_cents, 1.5);
  assert.equal(r.kalshi_rebate_cents, null);
});

test("observedFees: maker negative fee_cost → rebate", () => {
  const r = observedFeesFromKalshiFill({
    fee_cost: "-0.0020",
    is_taker: false,
  });
  assert.equal(r.kalshi_net_fee_cents, -0.2);
  assert.equal(r.kalshi_trade_fee_cents, null);
  assert.equal(r.kalshi_rebate_cents, 0.2);
});

test("observedFees: maker positive fee_cost → trade fee", () => {
  const r = observedFeesFromKalshiFill({
    fee_cost: "0.0030",
    is_taker: false,
  });
  assert.equal(r.kalshi_net_fee_cents, 0.3);
  assert.equal(r.kalshi_trade_fee_cents, 0.3);
  assert.equal(r.kalshi_rebate_cents, null);
});

test("observedFees: maker zero fee_cost → zero breakdown", () => {
  const r = observedFeesFromKalshiFill({
    fee_cost: "0.0000",
    is_taker: false,
  });
  assert.equal(r.kalshi_net_fee_cents, 0);
  assert.equal(r.kalshi_trade_fee_cents, 0);
  assert.equal(r.kalshi_rebate_cents, 0);
});
