/**
 * Orchestrator reconcile pass after process restart — Kalshi vs DB (W4).
 */

import { listWorkingMmOrdersForMarket, updateMmOrderStatus } from "./order-store.mjs";

/**
 * Extract Kalshi REST order id from various response shapes.
 *
 * @param {object} o
 */
function kalshiOrderId(o) {
  return o?.order_id != null ? String(o.order_id) : o?.id != null ? String(o.id) : "";
}

/**
 * @param {import('../providers/kalshi-trader.mjs').KalshiTrader} trader
 * @param {string} ticker
 */
async function fetchRestingKalshiOrdersRaw(trader, ticker) {
  const j = await trader.getOrders({ ticker, status: "resting" }).catch(() => ({ orders: [] }));
  const raw = j?.orders ?? j?.order ?? [];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

/**
 * @param {object} p
 * @param {import('pg').Client | import('pg').PoolClient} p.client
 * @param {import('../providers/kalshi-trader.mjs').KalshiTrader} p.trader
 * @param {Array<{ market_id: number|string, kalshi_ticker: string }>} p.markets
 * @returns {Promise<{ skipped: boolean, phase: string, logs: string[], wmPatch: Record<string, { bidOrd: string|null, askOrd: string|null, bidPx: number|null, askPx: number|null }> }>}
 */
export async function reconcileOnRestart(p) {
  const { client, trader, markets } = p;
  /** @type {string[]} */
  const logs = [];
  /** @type {Record<string, { bidOrd: string|null, askOrd: string|null, bidPx: number|null, askPx: number|null }>} */
  const wmPatch = {};

  if (!markets?.length) {
    return { skipped: true, phase: "no_markets", logs: ["reconcile_skipped_no_markets"], wmPatch: {} };
  }

  for (const row of markets) {
    const ticker = String(row.kalshi_ticker);
    const marketPk = row.market_id;
    const list = await fetchRestingKalshiOrdersRaw(trader, ticker);
    const restingIds = new Set(list.map(kalshiOrderId).filter(Boolean));
    const dbRows = await listWorkingMmOrdersForMarket(client, marketPk);

    /** Exchange orders not present in our DB → cancel (orphan). */
    const dbKalshi = new Set(
      dbRows.map((r) => r.kalshi_order_id).filter((x) => x != null && String(x).length > 0).map(String),
    );
    for (const kid of restingIds) {
      if (!dbKalshi.has(kid)) {
        try {
          await trader.cancelOrder(kid);
          logs.push(`reconcile ${ticker} cancel_orphan_exchange oid=${kid}`);
        } catch (e) {
          logs.push(`reconcile ${ticker} cancel_orphan_fail oid=${kid} ${/** @type {Error} */ (e).message}`);
        }
      }
    }

    /** DB rows with kalshi id not resting on exchange → no longer resting (cancelled/filled). */
    for (const dr of dbRows) {
      const kid = dr.kalshi_order_id != null ? String(dr.kalshi_order_id) : "";
      if (!kid) continue;
      if (!restingIds.has(kid)) {
        await updateMmOrderStatus(client, dr.id, "cancelled");
        logs.push(`reconcile ${ticker} db_stale_no_resting id=${dr.id} kalshi=${kid} -> cancelled`);
      }
    }

    /** Seed wm from Kalshi resting for replaceRow continuity. */
    let bidOrd = null;
    let askOrd = null;
    let bidPx = null;
    let askPx = null;
    for (const o of list) {
      const oid = kalshiOrderId(o);
      if (!oid) continue;
      const side = String(o.side ?? "");
      const act = String(o.action ?? "");
      const yesPx = o.yes_price != null ? Number(o.yes_price) : null;
      if (side === "yes" && act === "buy" && yesPx != null) {
        bidOrd = oid;
        bidPx = Math.round(yesPx);
      }
      if (side === "yes" && act === "sell" && yesPx != null) {
        askOrd = oid;
        askPx = Math.round(yesPx);
      }
    }
    wmPatch[ticker] = { bidOrd, askOrd, bidPx, askPx };
  }

  logs.push("reconcile_pass_complete");
  return { skipped: false, phase: "W4", logs, wmPatch };
}
