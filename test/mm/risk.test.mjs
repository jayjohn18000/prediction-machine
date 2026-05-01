import test from "node:test";
import assert from "node:assert/strict";
import {
  checkPreTrade,
  fetchPortfolioDailyNetPnLCentsUtc,
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

test("fetchPortfolioDailyNetPnLCentsUtc aggregates latest snapshot per market (query contract)", async () => {
  /** @type {string} */
  let sql = "";
  const client = {
    async query(q) {
      sql = q;
      return { rows: [{ n: "15" }] };
    },
  };
  const n = await fetchPortfolioDailyNetPnLCentsUtc(/** @type {any} */ (client));
  assert.equal(n, 15);
  assert.match(sql, /DISTINCT ON\s*\(\s*market_id\s*\)/);
  assert.match(sql, /ORDER BY\s+market_id\s*,\s*observed_at\s+DESC/i);
});

/** Mirrors corrected SQL: one row per market = highest observed_at for that market */
function sumLatestPerMarketFixture(
  /** @type {{ market_id: number, net_pnl_cents: number, observed_at: number }[]} */ rows,
) {
  const latest = /** @type {Map<number, { net_pnl_cents: number, observed_at: number }>} */ (new Map());
  for (const r of rows) {
    const cur = latest.get(r.market_id);
    if (!cur || r.observed_at > cur.observed_at) {
      latest.set(r.market_id, { net_pnl_cents: r.net_pnl_cents, observed_at: r.observed_at });
    }
  }
  let s = 0;
  for (const v of latest.values()) s += v.net_pnl_cents;
  return s;
}

test("fixture 3×2 intraday snapshots: naive sum over-counts vs latest-per-market rollup", () => {
  const rows = [
    { market_id: 10, net_pnl_cents: 100, observed_at: 1 },
    { market_id: 10, net_pnl_cents: 250, observed_at: 2 },
    { market_id: 20, net_pnl_cents: -30, observed_at: 1 },
    { market_id: 20, net_pnl_cents: 40, observed_at: 2 },
    { market_id: 30, net_pnl_cents: 5, observed_at: 1 },
    { market_id: 30, net_pnl_cents: -15, observed_at: 2 },
  ];
  const naive = rows.reduce((a, r) => a + r.net_pnl_cents, 0);
  const corrected = sumLatestPerMarketFixture(rows);
  assert.equal(naive, 350);
  assert.equal(corrected, 275);
  assert.notEqual(naive, corrected);
});
