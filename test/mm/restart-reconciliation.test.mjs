import test from "node:test";
import assert from "node:assert/strict";
import { reconcileOnRestart } from "../../lib/mm/restart-reconciliation.mjs";

/**
 * @typedef {{ cancelCalls: string[] }} CancelCtl
 */

/**
 * @returns {{ client: { query: Function }, ctl: CancelCtl }}
 */
function mkClient() {
  /** @type {{ cancelCalls: string[] }} */
  const ctl = { cancelCalls: [] };
  const client = {
    /**
     * @param {string} sql
     * @param {unknown[]} [params]
     */
    query: async (sql, params = []) => {
      if (/FROM pmci\.mm_orders/.test(sql)) {
        return { rows: [] };
      }
      return { rows: [], sql, params };
    },
  };
  return { client, ctl };
}

/**
 * @param {Array<()=>{orders?: object[]}|{orders?: object[]}>} orderResponses
 * @param {{ cancelCalls: string[] }} ctl
 */
function mkTrader(orderResponses, ctl) {
  let call = 0;
  return /** @type {any} */ ({
    async getOrders() {
      const factory = orderResponses[Math.min(call, orderResponses.length - 1)];
      call += 1;
      return typeof factory === "function" ? factory() : factory;
    },
    async cancelOrder(id) {
      ctl.cancelCalls.push(String(id));
      return {};
    },
  });
}

test("reconcile cancels orphan exchange orders not tracked in DB", async () => {
  const { client, ctl } = mkClient();
  const exch = [
    { order_id: "orph", side: "yes", action: "buy", yes_price: 50, status: "resting" },
  ];
  const trader = mkTrader(
    [
      () => ({
        orders: exch,
      }),
    ],
    ctl,
  );

  const r = await reconcileOnRestart({
    client: /** @type {any} */ (client),
    trader,
    markets: [{ kalshi_ticker: "KX-DEMO-X", market_id: 999 }],
  });
  assert.equal(r.skipped, false);
  assert.ok(r.logs.some((l) => l.includes("cancel_orphan")), r.logs.join("\n"));
  assert.ok(ctl.cancelCalls.includes("orph"));
});

test("reconcile returns wmPatch with bid/ask from resting yes orders", async () => {
  const { client, ctl } = mkClient();
  const exch = [
    { order_id: "b1", side: "yes", action: "buy", yes_price: 48, status: "resting" },
    { order_id: "a1", side: "yes", action: "sell", yes_price: 52, status: "resting" },
  ];
  const trader = mkTrader([() => ({ orders: exch })], ctl);

  const r = await reconcileOnRestart({
    client: /** @type {any} */ (client),
    trader,
    markets: [{ kalshi_ticker: "KX-M", market_id: 1 }],
  });
  const w = r.wmPatch["KX-M"];
  assert.ok(w);
  assert.equal(w.bidOrd, "b1");
  assert.equal(w.askOrd, "a1");
  assert.equal(w.bidPx, 48);
  assert.equal(w.askPx, 52);
});
