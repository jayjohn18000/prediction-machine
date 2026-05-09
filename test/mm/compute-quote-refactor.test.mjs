import test from "node:test";
import assert from "node:assert/strict";
import { updateFairValue } from "../../lib/mm/fair-value.mjs";
import { decideQuote } from "../../lib/mm/quoting-engine.mjs";
import { computeQuote } from "../../lib/mm/compute-quote.mjs";

test("computeQuote matches updateFairValue + decideQuote (fixture)", () => {
  const mmConfig = {
    kill_switch_active: false,
    soft_position_limit: 5,
    hard_position_limit: 12,
    min_half_spread_cents: 2,
    base_size_contracts: 3,
    k_vol: 1,
    inventory_skew_cents: 15,
    max_order_notional_cents: 500,
  };

  const fvCarry = {};
  const midKalshiCents = 54.2;
  const top = { bestBidCents: 52, bestAskCents: 56 };
  const spreadCents = 4;
  const nowMs = 1_700_000_000_000;
  const midObservedMs = nowMs - 2000;
  const dtMs = 5000;
  const netContractsYes = 1;

  const fv = updateFairValue({
    state: fvCarry,
    midKalshiCents,
    midPolyCents: null,
    weightKalshiLiquidity: 100,
    weightPolyLiquidity: null,
    nowMs,
    dtMs,
    midObservedMs,
  });
  const q = decideQuote({
    fairCents: fv.fair_value_cents,
    netContractsYes,
    volEstimateCents: spreadCents,
    config: mmConfig,
    topOfBook: top,
  });

  const bundle = computeQuote({
    fvCarry,
    midKalshiCents,
    midPolyCents: null,
    weightKalshiLiquidity: 100,
    weightPolyLiquidity: null,
    nowMs,
    dtMs,
    midObservedMs,
    netContractsYes,
    mmConfig,
    topOfBook: top,
    spreadCents,
  });

  assert.deepEqual(bundle.quote, q);
  assert.equal(bundle.fairValue.fair_value_cents, fv.fair_value_cents);
  assert.deepEqual(bundle.fvCarryNext, fv.carry);
});
