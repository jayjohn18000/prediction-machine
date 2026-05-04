import test from "node:test";
import assert from "node:assert/strict";
import {
  closingRoundTripPnlPerContract,
  evaluateWorstTradeAlarmAfterFill,
} from "../../lib/mm/worst-trade-alarm.mjs";

test("closingRoundTripPnlPerContract — long exit at −12c per contract", () => {
  const r = closingRoundTripPnlPerContract(10, 50, -10, 38);
  assert.ok(r);
  assert.equal(r.pnlPerContract, -12);
  assert.equal(r.closedContracts, 10);
});

test("evaluateWorstTradeAlarmAfterFill inserts worst_trade_alarm when loss ≤ −10c/contract", async () => {
  /** @type {unknown[][]} */
  const calls = [];
  const client = {
    /** @param {string} q */
    async query(q, params = []) {
      calls.push(params);
      if (/FROM pmci\.mm_fills/.test(q) && /ORDER BY observed_at DESC/.test(q)) {
        return { rows: [{ kalshi_fill_id: "open-abc", id: 99 }] };
      }
      if (/INSERT INTO pmci\.mm_kill_switch_events/.test(q)) {
        assert.equal(params[1], "worst_trade_alarm");
        const details = JSON.parse(String(params[2]));
        assert.equal(details.pnl_cents, -12);
        assert.equal(details.ticker, "KX-TEST");
        assert.equal(details.closing_fill_id, "close-xyz");
        assert.equal(details.opening_fill_id, "open-abc");
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  const out = await evaluateWorstTradeAlarmAfterFill(/** @type {any} */ (client), {
    marketId: 42,
    kalshiTicker: "KX-TEST",
    posBefore: { net_contracts: 10, avg_cost_cents: 50 },
    fillRow: { id: 100, kalshi_fill_id: "close-xyz" },
    side: "yes_sell",
    sizeContracts: 10,
    priceCents: 38,
    observedAtIso: "2026-05-04T12:00:00.000Z",
  });
  assert.equal(out.fired, true);
  assert.ok(calls.some((p) => p[1] === "worst_trade_alarm"));
});
