/**
 * Advisory-only worst trade alarm: logs mm_kill_switch_events without tripping kill_switch_active.
 */

import { yesNetDeltaContracts } from "./position-store.mjs";
import { appendMmOperationalEvent } from "./risk.mjs";

/**
 * Per-contract realized PnL on the portion of this fill that closes existing inventory
 * (same math as lib/mm/position-store.mjs rollupPositionAccounting).
 *
 * @param {number} prevN signed YES net before fill
 * @param {number|null} prevA avg cost cents before fill
 * @param {number} delta signed YES delta from this fill
 * @param {number} fillPriceCents YES-equivalent fill price
 * @returns {{ pnlPerContract: number, closedContracts: number }|null} null if not a closing leg or unknown avg
 */
export function closingRoundTripPnlPerContract(prevN, prevA, delta, fillPriceCents) {
  if (prevA == null || !Number.isFinite(prevA)) return null;
  if (!Number.isFinite(prevN) || !Number.isFinite(delta) || !Number.isFinite(fillPriceCents)) return null;
  if (delta === 0) return null;
  if (!((prevN > 0 && delta < 0) || (prevN < 0 && delta > 0))) return null;

  const P = fillPriceCents;
  const A = prevA;
  const newN = prevN + delta;

  let closedFromPosition;
  if ((prevN > 0 && newN > 0) || (prevN < 0 && newN < 0)) {
    closedFromPosition = Math.abs(delta);
  } else if (newN === 0) {
    closedFromPosition = Math.min(Math.abs(prevN), Math.abs(delta));
  } else {
    closedFromPosition = Math.abs(prevN);
  }

  if (!closedFromPosition || !Number.isFinite(closedFromPosition)) return null;

  const contribTotal =
    prevN > 0 ? (P - A) * closedFromPosition : (A - P) * closedFromPosition;
  const pnlPerContract = contribTotal / closedFromPosition;
  return { pnlPerContract, closedContracts: closedFromPosition };
}

/**
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {object} p
 * @param {number|string} p.marketId
 * @param {string} p.kalshiTicker
 * @param {{ net_contracts?: unknown, avg_cost_cents?: unknown|null }} p.posBefore
 * @param {{ id: unknown, kalshi_fill_id?: unknown|null }} p.fillRow
 * @param {string} p.side mm side
 * @param {number} p.sizeContracts
 * @param {number} p.priceCents
 * @param {string} p.observedAtIso
 */
export async function evaluateWorstTradeAlarmAfterFill(client, p) {
  const prevN = Number(p.posBefore?.net_contracts ?? 0);
  const prevAraw = p.posBefore?.avg_cost_cents;
  const prevA = prevAraw != null && prevAraw !== "" ? Number(prevAraw) : null;

  const delta = yesNetDeltaContracts(p.side, p.sizeContracts);
  const r = closingRoundTripPnlPerContract(prevN, prevA, delta, p.priceCents);
  if (r == null || r.pnlPerContract > -10) return { fired: false };

  /** @type {string[]} */
  const openingSides = prevN > 0 ? ["yes_buy", "no_sell"] : ["yes_sell", "no_buy"];
  const oRes = await client.query(
    `
    SELECT kalshi_fill_id::text AS kalshi_fill_id, id
    FROM pmci.mm_fills
    WHERE market_id = $1::bigint
      AND observed_at < $2::timestamptz
      AND side = ANY ($3::text[])
    ORDER BY observed_at DESC, id DESC
    LIMIT 1
    `,
    [p.marketId, p.observedAtIso, [...openingSides]],
  );
  const openKid = oRes.rows[0]?.kalshi_fill_id ?? null;
  const closeKid =
    p.fillRow?.kalshi_fill_id != null ? String(p.fillRow.kalshi_fill_id) : String(p.fillRow?.id ?? "");

  await appendMmOperationalEvent(client, {
    marketId: p.marketId,
    reason: "worst_trade_alarm",
    details: {
      ticker: p.kalshiTicker,
      closing_fill_id: closeKid,
      opening_fill_id: openKid,
      pnl_cents: r.pnlPerContract,
      size_contracts: r.closedContracts,
    },
  });

  return { fired: true };
}
