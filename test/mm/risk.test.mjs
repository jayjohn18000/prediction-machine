import test from "node:test";
import assert from "node:assert/strict";
import {
  checkPreTrade,
  shouldTripKillSwitchOnFailure,
} from "../../lib/mm/risk.mjs";

const baseCfg = {
  enabled: true,
  kill_switch_active: false,
  soft_position_limit: 5,
  hard_position_limit: 20,
  min_half_spread_cents: 2,
  base_size_contracts: 2,
  k_vol: 1,
  max_order_notional_cents: 5000,
  min_requote_cents: 2,
  stale_quote_timeout_seconds: 600,
  daily_loss_limit_cents: 50_000,
};

test("checkPreTrade fails kill_switch when active", async () => {
  const r = await checkPreTrade({
    client: /** @type {any} */ ({}),
    config: { ...baseCfg, kill_switch_active: true },
    ticker: "KXTEST",
    fairCents: 50,
    netContractsYes: 0,
    snapshotObservedAtMs: Date.now(),
    quoteSnapshot: { bidPx: 40, bidSize: 1, askPx: 60, askSize: 1 },
    portfolioDailyPnLCents: 0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.failedGate, "kill_switch");
});

test("checkPreTrade passes all gates baseline", async () => {
  const r = await checkPreTrade({
    client: /** @type {any} */ ({}),
    config: { ...baseCfg },
    ticker: "KXTEST",
    fairCents: 50,
    netContractsYes: 3,
    snapshotObservedAtMs: Date.now(),
    quoteSnapshot: { bidPx: 40, bidSize: 1, askPx: 60, askSize: 1 },
    portfolioDailyPnLCents: 0,
  });
  assert.equal(r.ok, true);
});

test("checkPreTrade trips daily_loss", async () => {
  const r = await checkPreTrade({
    client: /** @type {any} */ ({}),
    config: baseCfg,
    ticker: "KXTEST",
    fairCents: 50,
    netContractsYes: 0,
    snapshotObservedAtMs: Date.now(),
    quoteSnapshot: { bidPx: 40, bidSize: 1, askPx: 60, askSize: 1 },
    portfolioDailyPnLCents: -100_000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.failedGate, "daily_loss");
  assert.equal(shouldTripKillSwitchOnFailure("daily_loss"), true);
});

test("shouldTripKillSwitchOnFailure toxicity", () => {
  assert.equal(shouldTripKillSwitchOnFailure("toxicity_score"), true);
  assert.equal(shouldTripKillSwitchOnFailure("stale_snapshot"), false);
});
