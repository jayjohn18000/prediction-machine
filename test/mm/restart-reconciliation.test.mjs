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

test("reconcile loaded order: getOrder executed runs ingest + sync (not blind cancel)", async () => {
  /** @type {string[]} */
  const log = [];
  const trader = /** @type {any} */ ({
    async getOrders() {
      return { orders: [] };
    },
    async getOrder(kid) {
      log.push(`getOrder:${kid}`);
      return { order: { order_id: kid, status: "executed" } };
    },
    async getFills() {
      return { fills: [] };
    },
    async cancelOrder() {
      return {};
    },
  });

  const client = {
    /**
     * @param {string} sql
     * @param {unknown[]} [params]
     */
    async query(sql, params = []) {
      if (/status IN \('pending', 'open', 'partial'\)/.test(sql)) {
        return { rows: [{ id: 42, kalshi_order_id: "kal-1" }] };
      }
      if (/SELECT size_contracts::numeric AS sz/.test(sql)) {
        return { rows: [{ sz: 2 }] };
      }
      if (/FROM pmci.mm_fills/.test(sql) && /total_sz/.test(sql)) {
        return { rows: [{ total_sz: 2, last_at: new Date("2026-05-01T10:00:00Z"), vwap_px: 48 }] };
      }
      if (/UPDATE pmci.mm_orders SET\s+status/.test(sql)) {
        log.push(`UPDATE_status:${params[1]}`);
        return { rows: [] };
      }
      return { rows: [], sql, params };
    },
  };

  const r = await reconcileOnRestart({
    client: /** @type {any} */ (client),
    trader,
    markets: [{ kalshi_ticker: "KX-Z", market_id: 9 }],
  });
  assert.ok(r.logs.some((l) => l.includes("ingest+sync")), r.logs.join("\n"));
  assert.ok(log.some((x) => x.startsWith("getOrder:kal-1")));
  assert.ok(log.some((x) => x === "UPDATE_status:filled"));
});

test("reconcile getOrder hang times out -> cancelled within 6s", async () => {
  /** @type {string[]} */
  const updates = [];
  const trader = /** @type {any} */ ({
    async getOrders() {
      return { orders: [] };
    },
    async getOrder() {
      return new Promise(() => {});
    },
    async cancelOrder() {
      return {};
    },
  });

  const client = {
    /**
     * @param {string} sql
     * @param {unknown[]} [params]
     */
    async query(sql, params = []) {
      if (/status IN \('pending', 'open', 'partial'\)/.test(sql)) {
        return { rows: [{ id: 99, kalshi_order_id: "hang-kid" }] };
      }
      if (/UPDATE pmci.mm_orders SET\s+status/.test(sql)) {
        updates.push(String(params[1]));
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    },
  };

  const t0 = Date.now();
  const r = await reconcileOnRestart({
    client: /** @type {any} */ (client),
    trader,
    markets: [{ kalshi_ticker: "KX-HANG", market_id: 77 }],
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 6500, `elapsed ${elapsed}ms`);
  assert.ok(r.logs.some((l) => l.includes("db_stale_order_timeout")), r.logs.join("\n"));
  assert.ok(updates.includes("cancelled"));
});
