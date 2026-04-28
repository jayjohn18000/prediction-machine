/**
 * MM-side resolution driver (agent 04 §6.C) — enabled Kalshi markets → settlement fetch → DB.
 *
 * Walks `pmci.mm_market_config` WHERE enabled = true, resolves `provider_markets.provider_market_ref`
 * through Kalshi outcomes API, persists `pmci.market_outcomes`, and settles open `mm_positions`.
 */

import { fetchKalshiMarketOutcome } from "../resolution/kalshi-outcome.mjs";
import { persistSettlementObservation } from "../resolution/persist-outcomes.mjs";

/**
 * Map Kalshi binary outcome to YES settlement price in cents.
 *
 * @param {string|null|undefined} winningOutcome
 * @returns {0|100|null}
 */
export function settlementYesCentsFromKalshiOutcome(winningOutcome) {
  const w = String(winningOutcome ?? "")
    .trim()
    .toLowerCase();
  if (w === "yes" || w === "yes1" || w === "y") return 100;
  if (w === "no" || w === "no1" || w === "n") return 0;
  return null;
}

/**
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @returns {Promise<number|null>}
 */
async function kalshiProviderId(client) {
  const r = await client.query(`SELECT id FROM pmci.providers WHERE lower(code) = 'kalshi' LIMIT 1`);
  return r.rows[0]?.id != null ? Number(r.rows[0].id) : null;
}

/**
 * @param {object} p
 * @param {import('pg').Client | import('pg').PoolClient} p.client
 * @param {number} p.marketPk pmci.provider_markets.id
 * @param {string} p.kalshiTicker
 * @param {{ winningOutcome?: string|null }} p.outcome fetchKalshiMarketOutcome result after settled
 */
export async function settleOpenMmPositionOnResolution(p) {
  const { client, marketPk, kalshiTicker, outcome } = p;
  const S = settlementYesCentsFromKalshiOutcome(outcome.winningOutcome);
  if (S == null) return { settled: false, reason: "unknown_outcome_shape" };

  const posRes = await client.query(`SELECT * FROM pmci.mm_positions WHERE market_id = $1::bigint`, [marketPk]);
  const pos = posRes.rows[0];
  const net = pos?.net_contracts != null ? Number(pos.net_contracts) : 0;
  const avg = pos?.avg_cost_cents != null ? Number(pos.avg_cost_cents) : null;

  let realizedBump = 0;
  if (net !== 0 && avg != null && Number.isFinite(avg)) {
    realizedBump = net * (S - avg);
  }

  if (pos) {
    const prevReal = pos.realized_pnl_cents != null ? Number(pos.realized_pnl_cents) : 0;
    const newReal = (Number.isFinite(prevReal) ? prevReal : 0) + realizedBump;
    await client.query(
      `
      UPDATE pmci.mm_positions
      SET net_contracts = 0,
          avg_cost_cents = NULL,
          realized_pnl_cents = $2::numeric,
          unrealized_pnl_cents = 0,
          last_updated = now()
      WHERE market_id = $1::bigint
      `,
      [marketPk, newReal],
    );
  }

  await client.query(
    `
    UPDATE pmci.mm_orders
    SET status = 'resolved'
    WHERE market_id = $1::bigint
      AND status IN ('pending', 'open', 'partial', 'filled')
    `,
    [marketPk],
  );

  return { settled: true, settlement_yes_cents: S, realized_bump_cents: realizedBump, ticker: kalshiTicker };
}

/**
 * @param {import('pg').Client | import('pg').PoolClient} client
 * @param {object} [options]
 * @param {(msg: string) => void} [options.log]
 */
export async function runMmResolutionDriver(client, options = {}) {
  const log = options.log ?? console.log;
  const providerId = await kalshiProviderId(client);
  if (providerId == null) {
    throw new Error("mm-resolution: kalshi provider row missing");
  }

  const r = await client.query(
    `
    SELECT c.market_id, pm.provider_market_ref AS kalshi_ticker
    FROM pmci.mm_market_config c
    JOIN pmci.provider_markets pm ON pm.id = c.market_id
    JOIN pmci.providers pr ON pr.id = pm.provider_id AND lower(pr.code) = 'kalshi'
    WHERE c.enabled = true
    `,
  );

  const rows = r.rows ?? [];
  const stats = {
    examined: 0,
    kalshi_settled: 0,
    persisted: 0,
    position_settled: 0,
    skipped_open: 0,
    ambiguous_outcome: 0,
    errors: 0,
  };

  for (const row of rows) {
    stats.examined++;
    const ticker = String(row.kalshi_ticker ?? "");
    const marketPk = Number(row.market_id);
    if (!ticker) continue;

    try {
      const fetched = await fetchKalshiMarketOutcome(ticker);
      if (!fetched.settled) {
        stats.skipped_open++;
        continue;
      }
      stats.kalshi_settled++;

      await persistSettlementObservation(client, {
        providerMarketId: marketPk,
        providerId,
        winningOutcome: fetched.winningOutcome,
        winningOutcomeRaw: fetched.winningOutcomeRaw,
        resolvedAt: fetched.resolvedAt,
        resolutionSourceObserved: fetched.resolutionSource,
        rawSettlement: fetched.raw ?? {},
      });
      stats.persisted++;

      const mapped = settlementYesCentsFromKalshiOutcome(fetched.winningOutcome);
      if (mapped == null) {
        stats.ambiguous_outcome++;
        continue;
      }

      const settle = await settleOpenMmPositionOnResolution({
        client,
        marketPk,
        kalshiTicker: ticker,
        outcome: fetched,
      });
      if (settle.settled) stats.position_settled++;
    } catch (e) {
      stats.errors++;
      log(`[mm-resolution] error market_id=${marketPk} ${/** @type {Error} */ (e).message}`);
    }
  }

  return stats;
}
