/**
 * Pull Kalshi fills REST into pmci.mm_fills + position updates.
 */

import {
  insertFill,
  findMmOrderByKalshiId,
  syncMmOrderFillStateFromFills,
} from "./order-store.mjs";
import { mapKalshiFillToMmSide, fillYesPriceCents } from "./kalshi-fill-normalize.mjs";
import { upsertPositionFromMmFill, fetchMmPositionSnapshot } from "./position-store.mjs";
import { observedFeesFromKalshiFill } from "./kalshi-fill-fees.mjs";
import { evaluateWorstTradeAlarmAfterFill } from "./worst-trade-alarm.mjs";

/**
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {import('../providers/kalshi-trader.mjs').KalshiTrader} trader
 * @param {string} ticker
 * @param {number|string} marketPk
 */
export async function ingestFillsForTicker(client, trader, ticker, marketPk) {
  const j = await trader.getFills({ limit: 200, ticker }).catch(() => ({ fills: [] }));
  /** @type {string[]} */
  const logs = [];
  let newFills = 0;
  for (const f of j.fills ?? []) {
    const oid = String(f.order_id ?? "");
    if (!oid) continue;
    const parent = await findMmOrderByKalshiId(client, oid);
    if (!parent) continue;

    /** @type {string} */
    const observedIso =
      typeof f.created_time === "string"
        ? f.created_time
        : typeof f.ts === "number"
          ? new Date(f.ts).toISOString()
          : new Date().toISOString();
    const kid = String(f.fill_id ?? f.trade_id ?? "");
    if (!kid) continue;

    try {
      const fp = Number.parseFloat(String(f.count_fp ?? "0"));
      if (!Number.isFinite(fp) || fp <= 0) continue;
      const fillSide = parent.side ?? mapKalshiFillToMmSide(f);
      const feeCols = observedFeesFromKalshiFill(f);
      const posSnap = await fetchMmPositionSnapshot(client, marketPk);
      const priceCents = fillYesPriceCents(f);
      const res = await insertFill(client, {
        order_pk: parent.id,
        market_id: marketPk,
        observed_at: observedIso,
        price_cents: priceCents,
        size_contracts: fp,
        side: fillSide,
        kalshi_fill_id: kid,
        ...feeCols,
      });
      if (res.inserted) {
        newFills += 1;
        logs.push(`fill ${kid} order=${parent.client_order_id} sz=${fp}`);
        try {
          await evaluateWorstTradeAlarmAfterFill(client, {
            marketId: marketPk,
            kalshiTicker: ticker,
            posBefore: posSnap,
            fillRow: res.row,
            side: fillSide,
            sizeContracts: fp,
            priceCents,
            observedAtIso: observedIso,
          });
        } catch (we) {
          logs.push(`worst_trade_alarm_err ${/** @type {Error} */ (we).message}`);
        }
        await syncMmOrderFillStateFromFills(client, parent.id);
        try {
          await upsertPositionFromMmFill(client, marketPk, {
            side: fillSide,
            size_contracts: fp,
            price_cents: priceCents,
            observed_at: observedIso,
          });
        } catch (pe) {
          logs.push(`position_err ${kid} ${/** @type {Error} */ (pe).message}`);
        }
      }
    } catch (e) {
      logs.push(`fill_err ${/** @type {Error} */ (e).message}`);
    }
  }
  return { logs, newFills };
}
