import test from "node:test";
import assert from "node:assert/strict";
import { runHeartbeat } from "../../scripts/mm/mm-stream-heartbeat.mjs";

function marketRow(overrides = {}) {
  return {
    ticker: overrides.ticker ?? "KX-DEFAULT",
    market_id: overrides.market_id ?? 1,
    kill_switch_active: false,
    new_orders_window: overrides.new_orders_window ?? 10,
    currently_open_orders: overrides.currently_open_orders ?? 1,
    depth_with_yes_window: overrides.depth_with_yes_window ?? 500,
    pnl_snapshots_window: overrides.pnl_snapshots_window ?? 12,
    latest_order: new Date().toISOString(),
    ...overrides,
  };
}

test("8/8 markets meet threshold → ok=true, threshold_min_quoting=7", async () => {
  const rows = Array.from({ length: 8 }, (_, i) =>
    marketRow({ ticker: `KX-T${i}`, market_id: i + 1 }),
  );
  const client = {
    async query() {
      return { rows };
    },
  };
  const summary = await runHeartbeat({ client });
  assert.equal(summary.ok, true);
  assert.equal(summary.quoting_markets, 8);
  assert.equal(summary.threshold_min_quoting, 7);
});

test("7/8 markets meet threshold → ok=true", async () => {
  const rows = [
    ...Array.from({ length: 7 }, (_, i) => marketRow({ ticker: `KX-T${i}`, market_id: i + 1 })),
    marketRow({
      ticker: "KX-WEAK",
      market_id: 99,
      currently_open_orders: 0,
      depth_with_yes_window: 0,
      pnl_snapshots_window: 0,
    }),
  ];
  const client = {
    async query() {
      return { rows };
    },
  };
  const summary = await runHeartbeat({ client });
  assert.equal(summary.ok, true);
  assert.equal(summary.quoting_markets, 7);
  assert.equal(summary.threshold_min_quoting, 7);
});

test("6/8 markets meet threshold → ok=false", async () => {
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => marketRow({ ticker: `KX-T${i}`, market_id: i + 1 })),
    marketRow({
      ticker: "KX-WEAK1",
      market_id: 97,
      currently_open_orders: 0,
      depth_with_yes_window: 0,
      pnl_snapshots_window: 0,
    }),
    marketRow({
      ticker: "KX-WEAK2",
      market_id: 98,
      currently_open_orders: 0,
      depth_with_yes_window: 0,
      pnl_snapshots_window: 0,
    }),
  ];
  const client = {
    async query() {
      return { rows };
    },
  };
  const summary = await runHeartbeat({ client });
  assert.equal(summary.ok, false);
  assert.equal(summary.quoting_markets, 6);
});
