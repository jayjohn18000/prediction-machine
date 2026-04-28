import test from "node:test";
import assert from "node:assert/strict";

import {
  spreadCaptureCentsForFill,
  tradedSidePriceDollars,
  kalshiFeeCentsForMmFill,
  computeMarketPnl,
} from "../../lib/mm/pnl-attribution.mjs";

test("spreadCaptureCentsForFill — R7 yes_buy / yes_sell / no_buy / no_sell", () => {
  assert.equal(spreadCaptureCentsForFill("yes_buy", 50, 48, 2), (50 - 48) * 2);
  assert.equal(spreadCaptureCentsForFill("yes_sell", 50, 55, 1), (55 - 50) * 1);
  assert.equal(spreadCaptureCentsForFill("no_buy", 55, 50, 3), (50 - 55) * 3);
  assert.equal(spreadCaptureCentsForFill("no_sell", 44, 50, 2), (44 - 50) * 2);
});

test("tradedSidePriceDollars — YES vs NO traded side fee input", () => {
  assert.ok(Math.abs(tradedSidePriceDollars("yes_buy", 60) - 0.6) < 1e-9);
  assert.ok(Math.abs(tradedSidePriceDollars("no_buy", 60) - 0.4) < 1e-9);
});

test("kalshiFeeCentsForMmFill — known maker bracket", () => {
  const c = kalshiFeeCentsForMmFill({
    side: "yes_buy",
    price_cents: 50,
    size_contracts: 10,
    liquidityRole: "maker",
  });
  assert.ok(typeof c === "number" && c >= 0);
});

test("computeMarketPnl — synthetic fixture (R7 net = spread + adverse + drift − fees)", async () => {
  /** @returns {Promise<any>} */
  async function qh(sql) {
    const s = String(sql);
    if (s.includes("FROM pmci.mm_fills")) {
      return {
        rows: [
          {
            id: 1,
            price_cents: 48,
            size_contracts: 2,
            side: "yes_buy",
            observed_at: new Date(),
            fair_value_at_fill: 50,
            adverse_cents_5m: "-1",
            post_fill_mid_5m: "49",
            fair_for_spread: "50",
          },
        ],
      };
    }
    if (s.includes("FROM pmci.mm_positions") && !s.includes("INSERT")) {
      return {
        rows: [
          {
            net_contracts: 10,
            avg_cost_cents: "46",
            realized_pnl_cents: "0",
            unrealized_pnl_cents: "0",
          },
        ],
      };
    }
    if (s.includes("FROM pmci.provider_market_depth")) {
      return {
        rows: [{ mid_cents: "52" }],
      };
    }
    return { rows: [] };
  }

  const p = await computeMarketPnl({ query: qh }, { marketId: 42 });
  assert.equal(p.spread_capture_cents, 4);
  assert.equal(p.adverse_selection_cents, -2);
  const drift = (52 - 46) * 10;
  assert.equal(p.inventory_drift_cents, drift);

  let feeExpected = 0;
  feeExpected += kalshiFeeCentsForMmFill({
    side: "yes_buy",
    price_cents: 48,
    size_contracts: 2,
    liquidityRole: "maker",
  });
  assert.equal(p.fees_cents, feeExpected);

  const net = p.spread_capture_cents + p.adverse_selection_cents + p.inventory_drift_cents - p.fees_cents;
  assert.ok(Math.abs(p.net_cents - net) < 1e-9);
  assert.ok(Math.abs(p.net - net) < 1e-9);
});
