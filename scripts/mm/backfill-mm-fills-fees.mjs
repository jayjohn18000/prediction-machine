#!/usr/bin/env node
/**
 * Idempotent: copy observed fees from Kalshi GET /portfolio/fills into pmci.mm_fills.
 * Skips rows where kalshi_net_fee_cents is already set.
 *
 * Env:
 *   DATABASE_URL — required
 *   MM_RUN_MODE — prod | demo (default demo); selects KALSHI_PROD_* vs KALSHI_DEMO_*
 *
 * @see lib/mm/kalshi-env.mjs
 */
import "dotenv/config";

import { createPgClient } from "../../lib/mm/order-store.mjs";
import { observedFeesFromKalshiFill } from "../../lib/mm/kalshi-fill-fees.mjs";
import { kalshiEnvFromMode } from "../../lib/mm/kalshi-env.mjs";
import { KalshiTrader, loadPrivateKey } from "../../lib/providers/kalshi-trader.mjs";

/**
 * @param {InstanceType<KalshiTrader>} trader
 * @param {string} ticker
 */
async function fetchAllFillsForTicker(trader, ticker) {
  /** @type {any[]} */
  const out = [];
  let cursor = "";
  while (true) {
    /** @type {Record<string, string>} */
    /** @type {Record<string, string | number>} */
    const q = { ticker, limit: 1000 };
    if (cursor) q.cursor = cursor;
    const j = await trader.getFills(q).catch(() => ({ fills: [], cursor: "" }));
    const fills = Array.isArray(j?.fills) ? j.fills : [];
    out.push(...fills);
    cursor = typeof j?.cursor === "string" ? j.cursor : "";
    if (!cursor || fills.length === 0) break;
  }
  return out;
}

async function main() {
  const env = kalshiEnvFromMode();
  const keyId = env.apiKeyId;
  if (!keyId?.trim()) {
    throw new Error(
      env.runMode === "prod"
        ? "KALSHI_PROD_API_KEY_ID required for fee backfill"
        : "KALSHI_DEMO_API_KEY_ID (or KALSHI_API_KEY_ID) required for fee backfill",
    );
  }
  const privateKey = loadPrivateKey({ path: env.privateKeyPath, inline: env.privateKeyInline });
  const trader = new KalshiTrader({
    baseTradeUrl: env.restBase,
    keyId: String(keyId),
    privateKey,
  });

  const client = createPgClient();
  await client.connect();
  /** @type {{ updated: number, not_in_api: number, tickers_processed: number }} */
  const stats = { updated: 0, not_in_api: 0, tickers_processed: 0 };
  try {
    const need = await client.query(
      `
      SELECT DISTINCT pm.provider_market_ref AS ticker
      FROM pmci.mm_fills f
      JOIN pmci.provider_markets pm ON pm.id = f.market_id
      WHERE f.kalshi_fill_id IS NOT NULL
        AND f.kalshi_net_fee_cents IS NULL
      `,
    );
    const tickers = (need.rows ?? []).map((r) => String(r.ticker));

    for (const ticker of tickers) {
      stats.tickers_processed += 1;
      const kalshiFills = await fetchAllFillsForTicker(trader, ticker);
      /** @type {Map<string, ReturnType<typeof observedFeesFromKalshiFill>>} */
      const byId = new Map();
      for (const f of kalshiFills) {
        const kid = String(f.fill_id ?? f.trade_id ?? "");
        if (!kid) continue;
        byId.set(kid, observedFeesFromKalshiFill(f));
      }

      const rows = await client.query(
        `
        SELECT f.id, f.kalshi_fill_id
        FROM pmci.mm_fills f
        WHERE f.market_id = (
          SELECT pm_inner.id
          FROM pmci.provider_markets pm_inner
          JOIN pmci.providers pr_inner ON pm_inner.provider_id = pr_inner.id AND pr_inner.code = 'kalshi'
          WHERE pm_inner.provider_market_ref = $1
          LIMIT 1
        )
          AND f.kalshi_net_fee_cents IS NULL
          AND f.kalshi_fill_id IS NOT NULL
        `,
        [ticker],
      );

      for (const row of rows.rows ?? []) {
        const kid = String(row.kalshi_fill_id);
        const fees = byId.get(kid);
        if (!fees || fees.kalshi_net_fee_cents == null) {
          stats.not_in_api += 1;
          continue;
        }
        await client.query(
          `
          UPDATE pmci.mm_fills SET
            kalshi_net_fee_cents = $2::numeric,
            kalshi_trade_fee_cents = COALESCE($3::numeric, kalshi_trade_fee_cents),
            kalshi_rounding_fee_cents = COALESCE($4::numeric, kalshi_rounding_fee_cents),
            kalshi_rebate_cents = COALESCE($5::numeric, kalshi_rebate_cents)
          WHERE id = $1::bigint
            AND kalshi_net_fee_cents IS NULL
          `,
          [
            row.id,
            fees.kalshi_net_fee_cents,
            fees.kalshi_trade_fee_cents,
            fees.kalshi_rounding_fee_cents,
            fees.kalshi_rebate_cents,
          ],
        );
        stats.updated += 1;
      }
    }

    console.log(JSON.stringify({ ok: true, mode: env.runMode, ...stats }, null, 2));
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
