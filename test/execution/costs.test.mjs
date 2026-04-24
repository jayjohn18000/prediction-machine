import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateCost,
  contractPriceForSide,
  contractsFromPremiumUsd,
  V1_DEFAULT_SLIPPAGE_ONE_WAY_USD,
} from "../../lib/execution/costs.mjs";

test("contractPriceForSide", () => {
  assert.equal(contractPriceForSide(0.52, "yes"), 0.52);
  assert.equal(contractPriceForSide(0.52, "no"), 0.48);
});

test("contractsFromPremiumUsd", () => {
  assert.equal(contractsFromPremiumUsd({ premiumUsd: 100, priceYes: 0.5, side: "yes" }), 200);
  assert.equal(contractsFromPremiumUsd({ premiumUsd: 100, priceYes: 0.5, side: "no" }), 200);
});

test("estimateCost kalshi taker matches ceil fee at 50c", () => {
  const r = estimateCost({
    venue: "kalshi",
    side: "yes",
    price: 0.5,
    size: 100,
    hold_days: 0,
    slippage_one_way_usd: 0,
    include_capital_lockup: false,
  });
  // C = 200, P = 0.5, raw = 0.07 * 200 * 0.25 = 3.5
  assert.equal(r.breakdown.fees_dollars, 3.5);
  assert.equal(r.total_cost_dollars, 3.5);
});

test("estimateCost polymarket sports taker at 50c", () => {
  const r = estimateCost({
    venue: "polymarket",
    side: "yes",
    price: 0.5,
    size: 50,
    hold_days: 0,
    slippage_one_way_usd: 0,
    include_capital_lockup: false,
    polymarket_category: "sports",
  });
  // C = 100, rate 0.03, p(1-p)=0.25 => 0.75
  assert.equal(r.breakdown.fees_dollars, 0.75);
});

test("estimateCost includes slippage and lockup by default", () => {
  const r = estimateCost({
    venue: "polymarket",
    side: "yes",
    price: 0.4,
    size: 100,
    hold_days: 10,
  });
  assert.ok(r.breakdown.slippage_dollars >= V1_DEFAULT_SLIPPAGE_ONE_WAY_USD);
  assert.ok(r.breakdown.capital_lockup_dollars > 0);
  assert.ok(r.total_cost_dollars > r.breakdown.fees_dollars);
});

test("estimateCost polymarket maker pays no fee", () => {
  const r = estimateCost({
    venue: "polymarket",
    side: "yes",
    price: 0.5,
    size: 50,
    hold_days: 0,
    liquidity_role: "maker",
    slippage_one_way_usd: 0,
    include_capital_lockup: false,
  });
  assert.equal(r.breakdown.fees_dollars, 0);
});
