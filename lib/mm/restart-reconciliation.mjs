/**
 * Orchestrator reconcile pass after process restart — Kalshi vs DB (W4).
 */

import {
  listWorkingMmOrdersForMarket,
  updateMmOrderStatus,
  syncMmOrderFillStateFromFills,
} from "./order-store.mjs";
import { ingestFillsForTicker } from "./ingest-fills.mjs";

const REST_TERMINAL_LOOKUP_MS = 250;

/** Kalshi DEMO REST p99 is normally under 2s; bound hangs so startup reconcile cannot block the main loop forever. */
const KALSHI_RESTART_RECONCILE_TIMEOUT_MS = 5000;

/**
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T | null>}
 * @template T
 */
async function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    if (/** @type {Error} */ (err).message?.startsWith("timeout:")) {
      console.warn("mm.restart-reconciliation.kalshi_timeout", { label, ms });
      return null;
    }
    throw err;
  }
}

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
  const j = await withTimeout(
    trader.getOrders({ ticker, status: "resting" }).catch(() => ({ orders: [] })),
    KALSHI_RESTART_RECONCILE_TIMEOUT_MS,
    `getOrders:${ticker}`,
  );
  if (j == null) return [];
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
          const cancelled = await withTimeout(
            trader.cancelOrder(kid),
            KALSHI_RESTART_RECONCILE_TIMEOUT_MS,
            `cancelOrder:${kid}`,
          );
          if (cancelled == null) {
            logs.push(`reconcile ${ticker} cancel_orphan_timeout oid=${kid}`);
            continue;
          }
          logs.push(`reconcile ${ticker} cancel_orphan_exchange oid=${kid}`);
        } catch (e) {
          logs.push(`reconcile ${ticker} cancel_orphan_fail oid=${kid} ${/** @type {Error} */ (e).message}`);
        }
      }
    }

    /** DB rows with kalshi id not resting on exchange → query terminal state (filled vs cancelled). */
    for (const dr of dbRows) {
      const kid = dr.kalshi_order_id != null ? String(dr.kalshi_order_id) : "";
      if (!kid) continue;
      if (!restingIds.has(kid)) {
        await new Promise((r) => setTimeout(r, REST_TERMINAL_LOOKUP_MS));
        /** @type {string} */
        let terminal = "";
        try {
          const oj = await withTimeout(
            trader.getOrder(kid),
            KALSHI_RESTART_RECONCILE_TIMEOUT_MS,
            `getOrder:${kid}`,
          );
          if (oj == null) {
            await updateMmOrderStatus(client, dr.id, "cancelled");
            logs.push(`reconcile ${ticker} db_stale_order_timeout id=${dr.id} kalshi=${kid} -> cancelled`);
            continue;
          }
          const ord = oj?.order ?? oj;
          terminal = String(ord?.status ?? "").toLowerCase();
        } catch (e) {
          const st = /** @type {any} */ (e)?.status;
          if (st === 404) {
            await updateMmOrderStatus(client, dr.id, "cancelled");
            logs.push(`reconcile ${ticker} db_stale_order_404 id=${dr.id} kalshi=${kid} -> cancelled`);
            continue;
          }
          logs.push(
            `reconcile ${ticker} terminal_lookup_fail id=${dr.id} kalshi=${kid} ${/** @type {Error} */ (e).message}`,
          );
          continue;
        }

        if (terminal === "executed" || terminal === "filled") {
          await ingestFillsForTicker(client, trader, ticker, marketPk);
          await syncMmOrderFillStateFromFills(client, dr.id);
          logs.push(`reconcile ${ticker} db_stale_terminal=${terminal} id=${dr.id} kalshi=${kid} -> ingest+sync`);
        } else if (terminal === "canceled" || terminal === "cancelled") {
          await updateMmOrderStatus(client, dr.id, "cancelled");
          logs.push(`reconcile ${ticker} db_stale_cancelled id=${dr.id} kalshi=${kid}`);
        } else {
          await updateMmOrderStatus(client, dr.id, "cancelled");
          logs.push(
            `reconcile ${ticker} db_stale_unknown_terminal=${terminal || "empty"} id=${dr.id} kalshi=${kid} -> cancelled`,
          );
        }
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
