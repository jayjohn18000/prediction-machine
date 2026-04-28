/**
 * MM per-market P&L attribution — Contract R7 (docs/plans/phase-mm-mvp-plan.md W2.0 amendment).
 */

import { kalshiFeeUsdCeilCents } from "../execution/fees.kalshi.mjs";

/**
 * @param {string} side mm_orders / mm_fills side
 * @param {number} fairValueYesCents YES fair value (place-time), 0–100
 * @param {number} fillYesPriceCents executed price in YES-probability cents (0–100), per fill ingest
 * @param {number} sizeContracts
 * @returns {number} spread_capture contribution in cents for this fill
 */
export function spreadCaptureCentsForFill(side, fairValueYesCents, fillYesPriceCents, sizeContracts) {
  const FV = Number(fairValueYesCents);
  const P = Number(fillYesPriceCents);
  const sz = Number(sizeContracts);
  if (!Number.isFinite(FV) || !Number.isFinite(P) || !Number.isFinite(sz)) return 0;
  const s = String(side ?? "");
  if (s === "yes_buy" || s === "no_sell") return (FV - P) * sz;
  if (s === "yes_sell" || s === "no_buy") return (P - FV) * sz;
  return 0;
}

/**
 * Kalshi fee schedule expects price of the traded side in 0–1 dollars.
 *
 * @param {string} side
 * @param {number} fillYesPriceCents primary YES price stored on mm_fills
 */
export function tradedSidePriceDollars(side, fillYesPriceCents) {
  const px = Number(fillYesPriceCents);
  const yes = px / 100;
  const s = String(side ?? "");
  if (s === "yes_buy" || s === "yes_sell") return Math.min(1, Math.max(0, yes));
  const noPx = (100 - px) / 100;
  return Math.min(1, Math.max(0, noPx));
}

/**
 * Estimated Kalshi clearing fee per fill (cents), maker by default for posted quotes.
 *
 * @param {object} p
 * @param {string} p.side
 * @param {number} p.price_cents YES-equivalent fill price
 * @param {number} p.size_contracts
 * @param {'maker'|'taker'} [p.liquidityRole]
 */
export function kalshiFeeCentsForMmFill(p) {
  const role = p.liquidityRole ?? "maker";
  const usd = kalshiFeeUsdCeilCents({
    contracts: p.size_contracts,
    contractPrice: tradedSidePriceDollars(p.side, p.price_cents),
    liquidityRole: role,
  });
  return Math.round(usd * 100);
}

/**
 * @param {{ query: Function }} executor pg.Client or pool shim (`src/db.query`)
 * @param {object} opts
 * @param {number|string} opts.marketId pmci.provider_markets.id
 * @param {Date|string} [opts.asOf] attribution instant (default: now)
 * @param {'maker'|'taker'} [opts.feeLiquidityRole]
 */
export async function computeMarketPnl(executor, opts) {
  const marketId = Number(opts.marketId);
  const asOf = opts.asOf != null ? new Date(opts.asOf) : new Date();
  const feeRole = opts.feeLiquidityRole ?? "maker";

  const fillSql = `
    SELECT
      f.id,
      f.price_cents,
      f.size_contracts,
      f.side,
      f.observed_at,
      f.fair_value_at_fill,
      f.adverse_cents_5m,
      f.post_fill_mid_5m,
      COALESCE(o.fair_value_at_place::numeric, f.fair_value_at_fill::numeric) AS fair_for_spread
    FROM pmci.mm_fills f
    LEFT JOIN pmci.mm_orders o ON o.id = f.order_id
    WHERE f.market_id = $1::bigint
      AND f.observed_at <= $2::timestamptz
  `;
  const fillRes = await executor.query(fillSql, [marketId, asOf.toISOString()]);
  const rows = fillRes.rows ?? [];

  let spread_capture_cents = 0;
  let adverse_selection_cents = 0;
  let fees_cents = 0;

  for (const r of rows) {
    const fair = Number(r.fair_for_spread);
    if (Number.isFinite(fair)) {
      spread_capture_cents += spreadCaptureCentsForFill(
        r.side,
        fair,
        Number(r.price_cents),
        Number(r.size_contracts),
      );
    }
    if (r.post_fill_mid_5m != null && r.adverse_cents_5m != null) {
      const adv = Number(r.adverse_cents_5m);
      const sz = Number(r.size_contracts);
      if (Number.isFinite(adv) && Number.isFinite(sz)) {
        adverse_selection_cents += adv * sz;
      }
    }
    fees_cents += kalshiFeeCentsForMmFill({
      side: r.side,
      price_cents: Number(r.price_cents),
      size_contracts: Number(r.size_contracts),
      liquidityRole: feeRole,
    });
  }

  const posRes = await executor.query(
    `
    SELECT net_contracts, avg_cost_cents, realized_pnl_cents, unrealized_pnl_cents
    FROM pmci.mm_positions
    WHERE market_id = $1::bigint
    LIMIT 1
    `,
    [marketId],
  );
  const pos = posRes.rows[0];
  const netContracts = pos?.net_contracts != null ? Number(pos.net_contracts) : 0;
  const avgCost = pos?.avg_cost_cents != null ? Number(pos.avg_cost_cents) : null;

  const midRes = await executor.query(
    `
    SELECT mid_cents
    FROM pmci.provider_market_depth
    WHERE provider_market_id = $1::bigint
      AND observed_at <= $2::timestamptz
      AND mid_cents IS NOT NULL
    ORDER BY observed_at DESC
    LIMIT 1
    `,
    [marketId, asOf.toISOString()],
  );
  const mid = midRes.rows[0]?.mid_cents != null ? Number(midRes.rows[0].mid_cents) : null;

  let inventory_drift_cents = 0;
  let unrealized_mtm_cents = 0;
  if (
    Number.isFinite(netContracts) &&
    netContracts !== 0 &&
    avgCost != null &&
    Number.isFinite(avgCost) &&
    mid != null &&
    Number.isFinite(mid)
  ) {
    inventory_drift_cents = (mid - avgCost) * netContracts;
    unrealized_mtm_cents = inventory_drift_cents;
  }

  const net_cents =
    spread_capture_cents + adverse_selection_cents + inventory_drift_cents - fees_cents;

  const realized_cents_from_position = pos?.realized_pnl_cents != null ? Number(pos.realized_pnl_cents) : 0;

  return {
    market_id: marketId,
    as_of: asOf.toISOString(),
    spread_capture_cents,
    adverse_selection_cents,
    inventory_drift_cents,
    fees_cents,
    unrealized_mtm_cents,
    realized_cents_from_position,
    net_cents,
    /** Dashboard / Contract R7 field names (amounts in cents). */
    realized: spread_capture_cents,
    unrealized: unrealized_mtm_cents,
    fees: fees_cents,
    adverse_selection: adverse_selection_cents,
    net: net_cents,
    metadata: {
      net_contracts: netContracts || 0,
      mid_cents_observed: mid,
      avg_cost_cents: avgCost,
    },
  };
}

/**
 * Insert one R7 snapshot row (used by pg_cron → admin job).
 *
 * @param {{ query: Function }} executor
 * @param {number|string} marketId
 */
export async function insertPnlSnapshotRow(executor, marketId) {
  const p = await computeMarketPnl(executor, { marketId });
  await executor.query(
    `
    INSERT INTO pmci.mm_pnl_snapshots (
      market_id,
      observed_at,
      spread_capture_cents,
      adverse_selection_cents,
      inventory_drift_cents,
      fees_cents,
      net_pnl_cents
    ) VALUES ($1::bigint, now(), $2::numeric, $3::numeric, $4::numeric, $5::numeric, $6::numeric)
    `,
    [
      marketId,
      p.spread_capture_cents,
      p.adverse_selection_cents,
      p.inventory_drift_cents,
      p.fees_cents,
      p.net_cents,
    ],
  );
  return p;
}

/**
 * Run snapshot insert for every enabled MM market.
 *
 * @param {{ query: Function }} executor
 */
export async function insertPnlSnapshotsAllEnabledMarkets(executor) {
  const r = await executor.query(
    `SELECT market_id FROM pmci.mm_market_config WHERE enabled = true`,
  );
  const rows = r.rows ?? [];
  /** @type {Array<{ market_id: number, ok: boolean, error?: string }>} */
  const results = [];
  for (const row of rows) {
    const mid = Number(row.market_id);
    try {
      await insertPnlSnapshotRow(executor, mid);
      results.push({ market_id: mid, ok: true });
    } catch (e) {
      results.push({ market_id: mid, ok: false, error: /** @type {Error} */ (e).message });
    }
  }
  return { inserted: results.filter((x) => x.ok).length, results };
}
