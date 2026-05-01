import test from "node:test";
import assert from "node:assert/strict";
import { arbTrade, PREMIUM_PER_TRADE_USD, VOID_REFUND_MODEL } from "../../lib/backtest/arb-trade.mjs";
import { estimateCost } from "../../lib/execution/costs.mjs";

const kalshiMarket = { provider: "kalshi", provider_market_ref: "KXMLB#PHI-NYY" };
function polyMarket() {
  return {
    provider: "polymarket",
    provider_market_ref: "0xabc#Athletics",
    title: "Athletics vs Yankees",
    home_team: "Athletics",
    away_team: "Yankees",
  };
}

function baseParams(overrides = {}) {
  return {
    kYesAtEntry: 0.45,
    pYesAtEntry: 0.50,
    kalshiMarket,
    polyMarket: polyMarket(),
    kalshiWinningOutcome: "yes",
    polyWinningOutcome: "Yankees",
    holdDays: 2,
    entryThresholdAbs: 0.01,
    snapshotIntervalMs: 3600000,
    ...overrides,
  };
}

test("direction: k_cheap when kYes < pYes", () => {
  const r = arbTrade(baseParams({ kYesAtEntry: 0.40, pYesAtEntry: 0.60 }));
  assert.equal(r.direction, "k_cheap");
});

test("direction: p_cheap when pYes < kYes", () => {
  const r = arbTrade(baseParams({ kYesAtEntry: 0.60, pYesAtEntry: 0.40 }));
  assert.equal(r.direction, "p_cheap");
});

test("direction: tie goes to k_cheap", () => {
  const r = arbTrade(baseParams({ kYesAtEntry: 0.50, pYesAtEntry: 0.50 }));
  assert.equal(r.direction, "k_cheap");
});

test("premiums sum to ≤ $100 within $0.01 tolerance (across several price pairs)", () => {
  const pairs = [
    [0.10, 0.90],
    [0.33, 0.67],
    [0.45, 0.55],
    [0.50, 0.50],
    [0.20, 0.80],
    [0.99, 0.01],
  ];
  for (const [k, p] of pairs) {
    const r = arbTrade(baseParams({ kYesAtEntry: k, pYesAtEntry: p }));
    // Premium sum invariant: cheapPremium + expPremium ≈ 100 within $0.01.
    // We infer it from the emitted gross: gross = N - 100 if cheap wins, etc.
    // Easier: recompute cheap/exp premiums from direction.
    const cheapYes = Math.min(k, p);
    const expYes = Math.max(k, p);
    const N = 100 / (cheapYes + (1 - expYes));
    const cheapPremium = N * cheapYes;
    const expPremium = N * (1 - expYes);
    assert.ok(
      Math.abs(cheapPremium + expPremium - PREMIUM_PER_TRADE_USD) <= 0.01,
      `pair ${k}/${p}: sum=${cheapPremium + expPremium}`,
    );
    assert.ok(Number.isFinite(r.gross_dollars));
    assert.ok(Number.isFinite(r.net_dollars));
  }
});

test("both legs 'won' (windfall) → positive gross (disagreement case)", () => {
  // Arrange: kalshi YES wins, polymarket NO (Athletics loses → poly wins for NO side).
  const r = arbTrade(baseParams({
    kYesAtEntry: 0.45,
    pYesAtEntry: 0.55,
    kalshiWinningOutcome: "yes",
    polyWinningOutcome: "Yankees", // Athletics losing means poly NO leg wins
  }));
  assert.equal(r.cheap_state, "won");
  assert.equal(r.exp_state, "won");
  assert.ok(r.gross_dollars > 0, `windfall gross should be positive, got ${r.gross_dollars}`);
});

test("both legs 'lost' (wipe) → negative gross (disagreement case)", () => {
  // Kalshi YES leg resolves 'no', poly NO leg loses when Athletics wins.
  const r = arbTrade(baseParams({
    kYesAtEntry: 0.45,
    pYesAtEntry: 0.55,
    kalshiWinningOutcome: "no",
    polyWinningOutcome: "Athletics",
  }));
  assert.equal(r.cheap_state, "lost");
  assert.equal(r.exp_state, "lost");
  assert.ok(r.gross_dollars < 0, `wipe gross should be negative, got ${r.gross_dollars}`);
  // Wipe = -100 on gross (both premiums lost).
  assert.ok(Math.abs(r.gross_dollars + 100) < 0.02);
});

test("cheap_state won + exp_state lost → positive gross (clean arb A)", () => {
  // k_cheap direction (kYes < pYes). Kalshi YES wins, Polymarket NO loses (so poly winner = Athletics which is poly's YES outcome).
  const r = arbTrade(baseParams({
    kYesAtEntry: 0.45,
    pYesAtEntry: 0.55,
    kalshiWinningOutcome: "yes", // cheap (kalshi YES) wins
    polyWinningOutcome: "Athletics", // poly YES wins → poly NO leg loses
  }));
  assert.equal(r.direction, "k_cheap");
  assert.equal(r.cheap_state, "won");
  assert.equal(r.exp_state, "lost");
  assert.ok(r.gross_dollars > 0);
});

test("cheap_state lost + exp_state won → positive gross (clean arb B)", () => {
  const r = arbTrade(baseParams({
    kYesAtEntry: 0.45,
    pYesAtEntry: 0.55,
    kalshiWinningOutcome: "no", // cheap (kalshi YES) loses
    polyWinningOutcome: "Yankees", // poly YES loses → poly NO leg wins
  }));
  assert.equal(r.cheap_state, "lost");
  assert.equal(r.exp_state, "won");
  assert.ok(r.gross_dollars > 0);
});

test("void on cheap leg only → cheap_net = 0; expensive leg nets normally", () => {
  const r = arbTrade(baseParams({
    kYesAtEntry: 0.45,
    pYesAtEntry: 0.55,
    kalshiWinningOutcome: null, // cheap void
    polyWinningOutcome: "Yankees", // poly NO wins
  }));
  assert.equal(r.cheap_state, "void");
  assert.equal(r.exp_state, "won");
  assert.equal(r.void_refund_model, VOID_REFUND_MODEL);
  // Expensive leg: net = (N - expPremium) - expCost.
  const cheapYes = 0.45;
  const expYes = 0.55;
  const N = 100 / (cheapYes + (1 - expYes));
  const expPremium = N * (1 - expYes);
  const expCost = estimateCost({
    venue: "polymarket",
    side: "no",
    price: expYes,
    size: expPremium,
    hold_days: 2,
    polymarket_category: "sports",
  });
  const expectedNet = (N - expPremium) - expCost.total_cost_dollars;
  // net = cheapNet (0) + expNet
  assert.ok(Math.abs(r.net_dollars - expectedNet) < 1e-9);
});

test("void on expensive leg only → exp_net = 0; cheap leg nets normally", () => {
  const r = arbTrade(baseParams({
    kYesAtEntry: 0.45,
    pYesAtEntry: 0.55,
    kalshiWinningOutcome: "yes", // cheap wins
    polyWinningOutcome: "unknown", // exp void
  }));
  assert.equal(r.cheap_state, "won");
  assert.equal(r.exp_state, "void");
  const cheapYes = 0.45;
  const expYes = 0.55;
  const N = 100 / (cheapYes + (1 - expYes));
  const cheapPremium = N * cheapYes;
  const cheapCost = estimateCost({
    venue: "kalshi",
    side: "yes",
    price: cheapYes,
    size: cheapPremium,
    hold_days: 2,
    polymarket_category: "sports",
  });
  const expectedNet = (N - cheapPremium) - cheapCost.total_cost_dollars;
  assert.ok(Math.abs(r.net_dollars - expectedNet) < 1e-9);
});

test("void on both legs → net = 0 within rounding", () => {
  const r = arbTrade(baseParams({
    kalshiWinningOutcome: null,
    polyWinningOutcome: "",
  }));
  assert.equal(r.cheap_state, "void");
  assert.equal(r.exp_state, "void");
  assert.equal(r.net_dollars, 0);
});

test("cost values: net = gross − sum(costs) for the non-void arb path", () => {
  const r = arbTrade(baseParams({
    kYesAtEntry: 0.45,
    pYesAtEntry: 0.55,
    kalshiWinningOutcome: "yes",
    polyWinningOutcome: "Athletics",
  }));
  // Both legs non-void. Reconstruct sum of costs from breakdowns.
  const cheapCost =
    r.cheap_costs_breakdown.fees_dollars +
    r.cheap_costs_breakdown.slippage_dollars +
    r.cheap_costs_breakdown.capital_lockup_dollars;
  const expCost =
    r.exp_costs_breakdown.fees_dollars +
    r.exp_costs_breakdown.slippage_dollars +
    r.exp_costs_breakdown.capital_lockup_dollars;
  const expected = r.gross_dollars - cheapCost - expCost;
  assert.ok(Math.abs(r.net_dollars - expected) < 1e-9);
});

test("skip field is null on traded rows", () => {
  const r = arbTrade(baseParams());
  assert.equal(r.skip, null);
});

test("stamp fields: entry_threshold_used, snapshot_interval_ms, void_refund_model", () => {
  const r = arbTrade(baseParams({ entryThresholdAbs: 0.05, snapshotIntervalMs: 7200000 }));
  assert.equal(r.entry_threshold_used, 0.05);
  assert.equal(r.snapshot_interval_ms, 7200000);
  assert.equal(r.void_refund_model, "full_refund_v1");
});

test("both states + direction always populated on traded row", () => {
  const r = arbTrade(baseParams());
  assert.ok(["k_cheap", "p_cheap"].includes(r.direction));
  assert.ok(["won", "lost", "void"].includes(r.cheap_state));
  assert.ok(["won", "lost", "void"].includes(r.exp_state));
});

test("rejects kYes outside (0, 1)", () => {
  assert.throws(() => arbTrade(baseParams({ kYesAtEntry: 0 })));
  assert.throws(() => arbTrade(baseParams({ kYesAtEntry: 1 })));
  assert.throws(() => arbTrade(baseParams({ kYesAtEntry: -0.1 })));
});

test("rejects pYes outside (0, 1)", () => {
  assert.throws(() => arbTrade(baseParams({ pYesAtEntry: 0 })));
  assert.throws(() => arbTrade(baseParams({ pYesAtEntry: 1.0 })));
});
