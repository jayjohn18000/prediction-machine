import test from "node:test";
import assert from "node:assert/strict";
import {
  decideQuote,
  clampQuotePxToFairBand,
  quoteSlippageBufferCents,
} from "../../lib/mm/quoting-engine.mjs";

test("clampQuotePxToFairBand pulls tail prices back toward fair", () => {
  assert.equal(clampQuotePxToFairBand(99, 30, 3, 0), 33);
  assert.equal(clampQuotePxToFairBand(1, 70, 4, 0), 66);
});

test("decideQuote: each quoted leg stays within halfSpread + buffer of fair", () => {
  const cfg = {
    soft_position_limit: 5,
    hard_position_limit: 10,
    min_half_spread_cents: 3,
    base_size_contracts: 2,
    k_vol: 1,
    kill_switch_active: false,
    max_order_notional_cents: 99999,
  };
  const fair = 26;
  const q = decideQuote({
    fairCents: fair,
    netContractsYes: 0,
    volEstimateCents: 2,
    config: cfg,
  });
  const maxD = q.halfSpreadCents + quoteSlippageBufferCents();
  if (q.bidPx != null) assert.ok(Math.abs(q.bidPx - fair) <= maxD);
  if (q.askPx != null) assert.ok(Math.abs(q.askPx - fair) <= maxD);
});

test("decideQuote: wide TOB cannot pin ask at 99¢ when fair is low (floor-clamp regression)", () => {
  const cfg = {
    soft_position_limit: 5,
    hard_position_limit: 10,
    min_half_spread_cents: 2,
    base_size_contracts: 1,
    k_vol: 1,
    kill_switch_active: false,
    max_order_notional_cents: 99999,
  };
  const fair = 22;
  const q = decideQuote({
    fairCents: fair,
    netContractsYes: 0,
    volEstimateCents: 3,
    config: cfg,
    topOfBook: { bestBidCents: 90, bestAskCents: 92 },
  });
  const maxD = q.halfSpreadCents + quoteSlippageBufferCents();
  if (q.askPx != null) {
    assert.ok(q.askPx <= fair + maxD, `askPx=${q.askPx} fair=${fair} maxD=${maxD}`);
    assert.ok(q.askPx < 90, "expected band clamp below artificial TOB ask pull");
  }
});
