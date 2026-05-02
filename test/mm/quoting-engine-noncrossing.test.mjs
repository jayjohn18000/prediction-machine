import test from "node:test";
import assert from "node:assert/strict";
import { decideQuote } from "../../lib/mm/quoting-engine.mjs";

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

function pickComparable(q) {
  return {
    bidPx: q.bidPx,
    bidSize: q.bidSize,
    askPx: q.askPx,
    askSize: q.askSize,
    halted: q.halted,
    halfSpreadCents: q.halfSpreadCents,
    skewAppliedCents: q.skewAppliedCents,
    reason: q.reason,
    bidSkippedReason: q.bidSkippedReason,
    askSkippedReason: q.askSkippedReason,
  };
}

test("no topOfBook matches omitting topOfBook (regression)", () => {
  const a = decideQuote({
    fairCents: 50,
    netContractsYes: 0,
    volEstimateCents: 4,
    config: baseCfg,
  });
  const b = decideQuote({
    fairCents: 50,
    netContractsYes: 0,
    volEstimateCents: 4,
    config: baseCfg,
    topOfBook: undefined,
  });
  assert.deepEqual(pickComparable(a), pickComparable(b));
});

test("bestAsk 50: bid 49 unchanged, ask 51 (half=1, no skew)", () => {
  const prev = process.env.MM_SKEW_CENTS_AT_HARD;
  process.env.MM_SKEW_CENTS_AT_HARD = "0";
  try {
    const q = decideQuote({
      fairCents: 50,
      netContractsYes: 0,
      volEstimateCents: 1,
      config: { ...baseCfg, min_half_spread_cents: 1 },
      topOfBook: { bestAskCents: 50, bestBidCents: null },
    });
    assert.equal(q.bidPx, 49);
    assert.equal(q.askPx, 51);
    assert.ok(q.bidSize > 0);
    assert.ok(q.askSize > 0);
  } finally {
    if (prev === undefined) delete process.env.MM_SKEW_CENTS_AT_HARD;
    else process.env.MM_SKEW_CENTS_AT_HARD = prev;
  }
});

test("inventory short YES pushes bid to 51; bestAsk 50 clamps bid to 49", () => {
  const q = decideQuote({
    fairCents: 50,
    netContractsYes: -10,
    volEstimateCents: 4,
    config: baseCfg,
    topOfBook: { bestAskCents: 50 },
  });
  assert.equal(q.bidPx, 49);
  assert.equal(q.askPx, 59);
});

test("bestAsk 1 forces bid side would_cross (bidSize 0)", () => {
  const prev = process.env.MM_SKEW_CENTS_AT_HARD;
  process.env.MM_SKEW_CENTS_AT_HARD = "0";
  try {
    const q = decideQuote({
      fairCents: 50,
      netContractsYes: 0,
      volEstimateCents: 1,
      config: { ...baseCfg, min_half_spread_cents: 1 },
      topOfBook: { bestAskCents: 1 },
    });
    assert.equal(q.bidSkippedReason, "would_cross");
    assert.equal(q.bidSize, 0);
    assert.equal(q.bidPx, null);
  } finally {
    if (prev === undefined) delete process.env.MM_SKEW_CENTS_AT_HARD;
    else process.env.MM_SKEW_CENTS_AT_HARD = prev;
  }
});

test("bestBid 99 forces ask side would_cross (askSize 0)", () => {
  const prev = process.env.MM_SKEW_CENTS_AT_HARD;
  process.env.MM_SKEW_CENTS_AT_HARD = "0";
  try {
    const q = decideQuote({
      fairCents: 50,
      netContractsYes: 0,
      volEstimateCents: 1,
      config: { ...baseCfg, min_half_spread_cents: 1 },
      topOfBook: { bestBidCents: 99 },
    });
    assert.equal(q.askSkippedReason, "would_cross");
    assert.equal(q.askSize, 0);
    assert.equal(q.askPx, null);
  } finally {
    if (prev === undefined) delete process.env.MM_SKEW_CENTS_AT_HARD;
    else process.env.MM_SKEW_CENTS_AT_HARD = prev;
  }
});

test("both top-of-book sides null: no clamp (same as no topOfBook)", () => {
  const a = decideQuote({
    fairCents: 50,
    netContractsYes: -10,
    volEstimateCents: 4,
    config: baseCfg,
  });
  const b = decideQuote({
    fairCents: 50,
    netContractsYes: -10,
    volEstimateCents: 4,
    config: baseCfg,
    topOfBook: { bestBidCents: null, bestAskCents: null },
  });
  assert.deepEqual(pickComparable(a), pickComparable(b));
});

test("without topOfBook: heavy short-YES skew keeps internal spread (self-cross path unchanged)", () => {
  const q = decideQuote({
    fairCents: 50,
    netContractsYes: -10,
    volEstimateCents: 4,
    config: baseCfg,
  });
  assert.ok(q.askPx > q.bidPx);
  assert.equal(q.bidPx, 51);
  assert.equal(q.askPx, 59);
  assert.equal(q.bidSkippedReason, undefined);
  assert.equal(q.askSkippedReason, undefined);
});
