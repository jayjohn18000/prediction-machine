import test from "node:test";
import assert from "node:assert/strict";
import {
  decideQuote,
  applyMinRequoteGuard,
  capSizeForNotional,
  inventorySkewCentsV1,
} from "../../lib/mm/quoting-engine.mjs";

const baseCfg = {
  soft_position_limit: 5,
  hard_position_limit: 20,
  min_half_spread_cents: 2,
  base_size_contracts: 2,
  k_vol: 1,
  kill_switch_active: false,
  max_order_notional_cents: 5000,
  min_requote_cents: 2,
  stale_quote_timeout_seconds: 600,
  daily_loss_limit_cents: 500_000,
  inventory_skew_cents: 15,
};

test("decideQuote halts on kill_switch", () => {
  const q = decideQuote({
    fairCents: 50,
    netContractsYes: 0,
    volEstimateCents: 4,
    config: { ...baseCfg, kill_switch_active: true },
  });
  assert.equal(q.halted, true);
});

test("decideQuote returns symmetric ladder around fair", () => {
  const prev = process.env.MM_SKEW_CENTS_AT_HARD;
  process.env.MM_SKEW_CENTS_AT_HARD = "0";
  try {
    const q = decideQuote({
      fairCents: 50,
      netContractsYes: 0,
      volEstimateCents: 4,
      config: baseCfg,
    });
    assert.equal(q.halted, false);
    assert.ok(Number(q.bidPx) < 50 && Number(q.askPx) > 50);
  } finally {
    if (prev === undefined) delete process.env.MM_SKEW_CENTS_AT_HARD;
    else process.env.MM_SKEW_CENTS_AT_HARD = prev;
  }
});

test("inventorySkewCentsV1 is flat inside soft band (v1 piecewise)", () => {
  assert.equal(inventorySkewCentsV1(4, 5, 20, 15), 0);
  assert.equal(inventorySkewCentsV1(-4, 5, 20, 15), 0);
});

test("inventorySkewCentsV1 reaches full skew at hard", () => {
  assert.equal(inventorySkewCentsV1(20, 5, 20, 15), -15);
  assert.equal(inventorySkewCentsV1(-20, 5, 20, 15), 15);
});

test("capSizeForNotional shrinks oversized child orders", () => {
  assert.equal(capSizeForNotional(50, 200, 1000), 20);
});

test("applyMinRequoteGuard suppresses microscopic changes", () => {
  const g = applyMinRequoteGuard({
    minRequoteCents: 5,
    lastBidCents: 40,
    lastAskCents: 60,
    newBidPx: 41,
    newAskPx: 59,
  });
  assert.equal(g.rebidBid, false);
  assert.equal(g.reboundAsk, false);
});
