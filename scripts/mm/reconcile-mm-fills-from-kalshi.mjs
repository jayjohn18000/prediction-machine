#!/usr/bin/env node
/**
 * One-shot: rewrite pmci.mm_fills rows so each row matches Kalshi's authoritative
 * /portfolio/fills response. Two fixes go in:
 *
 *   1. size_contracts: replace the legacy Math.max(1, Math.round(count_fp)) value
 *      with the actual fractional count_fp from Kalshi (now that the column is
 *      numeric — see migration 20260430153000_pmci_mm_fractional_contract_support).
 *   2. side: replace whatever mapKalshiFillToMmSide produced with the parent
 *      pmci.mm_orders.side. The parent carries the intended mm_side at placement;
 *      Kalshi normalizes fill side/action away from that intent, which prior code
 *      misread.
 *
 * After rewriting fills, recomputes pmci.mm_positions per market via
 * recomputeMmPositionForMarket so net_contracts matches Kalshi.
 *
 * Idempotent: safe to re-run; only changes rows where the new (size,side) differ.
 *
 * Env:
 *   DATABASE_URL                  — required
 *   KALSHI_DEMO_API_KEY_ID        — required
 *   KALSHI_DEMO_PRIVATE_KEY_PATH  or  KALSHI_DEMO_PRIVATE_KEY (PEM inline)
 *   KALSHI_DEMO_REST_BASE         — defaults to https://demo-api.kalshi.co/trade-api/v2
 */
import "dotenv/config";

import { createPgClient } from "../../lib/mm/order-store.mjs";
import { recomputeMmPositionForMarket } from "../../lib/mm/position-store.mjs";
import { KalshiTrader, loadPrivateKey } from "../../lib/providers/kalshi-trader.mjs";

async function reconcileMarket(client, trader, ticker, marketPk) {
  const stats = { ticker, market_id: marketPk, kalshi_fills: 0, db_fills: 0, updated: 0, missing: 0 };

  const j = await trader.getFills({ ticker, limit: 1000 }).catch(() => ({ fills: [] }));
  const kalshiFills = Array.isArray(j?.fills) ? j.fills : [];
  stats.kalshi_fills = kalshiFills.length;

  for (const kf of kalshiFills) {
    const kid = String(kf.fill_id ?? kf.trade_id ?? "");
    if (!kid) continue;
    const cfp = Number.parseFloat(String(kf.count_fp ?? "0"));
    if (!Number.isFinite(cfp) || cfp <= 0) continue;

    // Look up our row + parent order for the side intent.
    const r = await client.query(
      `SELECT f.id, f.order_id, f.size_contracts, f.side, o.side AS parent_side
       FROM pmci.mm_fills f
       LEFT JOIN pmci.mm_orders o ON o.id = f.order_id
       WHERE f.kalshi_fill_id = $1`,
      [kid],
    );
    const row = r.rows[0];
    if (!row) {
      stats.missing += 1;
      continue;
    }
    stats.db_fills += 1;

    const targetSide = row.parent_side ?? row.side;
    const sizeChanged = Math.abs(Number(row.size_contracts) - cfp) > 1e-6;
    const sideChanged = String(row.side) !== String(targetSide);
    if (!sizeChanged && !sideChanged) continue;

    await client.query(
      `UPDATE pmci.mm_fills
         SET size_contracts = $2::numeric,
             side = $3::text
       WHERE id = $1`,
      [row.id, cfp, targetSide],
    );
    stats.updated += 1;
  }

  // Rebuild mm_positions for this market from the corrected fills.
  const pos = await recomputeMmPositionForMarket(client, marketPk);
  stats.recomputed_position = {
    fills_seen: pos.fills_seen,
    net_contracts: pos.net_contracts,
    avg_cost_cents: pos.avg_cost_cents,
    realized_pnl_cents: pos.realized_pnl_cents,
  };
  return stats;
}

async function main() {
  const restBase =
    process.env.KALSHI_DEMO_REST_BASE?.trim() ||
    process.env.KALSHI_BASE?.trim() ||
    "https://demo-api.kalshi.co/trade-api/v2";
  const keyId = process.env.KALSHI_DEMO_API_KEY_ID ?? process.env.KALSHI_API_KEY_ID;
  if (!keyId?.trim()) throw new Error("KALSHI_DEMO_API_KEY_ID required");
  const privateKey = loadPrivateKey({
    path: process.env.KALSHI_DEMO_PRIVATE_KEY_PATH,
    inline: process.env.KALSHI_DEMO_PRIVATE_KEY,
  });
  const trader = new KalshiTrader({ baseTradeUrl: restBase, keyId: String(keyId), privateKey });

  const client = createPgClient();
  await client.connect();
  /** @type {Array<object>} */
  const summary = [];
  try {
    const r = await client.query(
      `SELECT DISTINCT pm.id AS market_id, pm.provider_market_ref AS ticker
         FROM pmci.mm_fills f
         JOIN pmci.provider_markets pm ON pm.id = f.market_id
       ORDER BY pm.provider_market_ref`,
    );
    const markets = r.rows ?? [];
    for (const row of markets) {
      const stats = await reconcileMarket(client, trader, String(row.ticker), Number(row.market_id));
      summary.push(stats);
    }
    console.log(JSON.stringify({ ok: true, markets_reconciled: summary.length, summary }, null, 2));
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[reconcile-mm-fills-from-kalshi]", err);
    process.exit(1);
  });
}
