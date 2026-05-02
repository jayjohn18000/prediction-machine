#!/usr/bin/env node
/**
 * One-shot script to cancel any pmci.mm_orders rows still in status='open'.
 * Used post-2026-05-02 ADR-012 cutover when 24 stranded orders were left
 * on PROD by the brief enabled-DEMO-rows window before mm_market_config
 * was disabled.
 *
 * Reads KALSHI env via lib/mm/kalshi-env.mjs (honors MM_RUN_MODE).
 * Calls trader.cancelOrder for each open order; updates mm_orders.status.
 *
 * Idempotent: re-running after all orders are canceled does nothing.
 */
import "dotenv/config";
import { KalshiTrader, loadPrivateKey } from "../../lib/providers/kalshi-trader.mjs";
import { kalshiEnvFromMode } from "../../lib/mm/kalshi-env.mjs";
import { createPgClient, updateMmOrderStatus } from "../../lib/mm/order-store.mjs";

async function main() {
  const env = kalshiEnvFromMode();
  console.log(`[cancel-orphans] mode=${env.runMode} rest=${env.restBase}`);

  if (!env.apiKeyId) throw new Error("apiKeyId missing — abort");
  const pk = loadPrivateKey({ path: env.privateKeyPath, inline: env.privateKeyInline });
  const trader = new KalshiTrader({
    baseTradeUrl: env.restBase,
    keyId: String(env.apiKeyId),
    privateKey: pk,
  });

  const client = createPgClient();
  await client.connect();

  // Window guard: only act on orders placed in today's PROD-mode window unless
  // CANCEL_ALL_OPEN=1 is set. Historical mm_orders.status='open' rows from
  // earlier DEMO sessions are left to a separate reconciliation pass.
  const cancelAll = process.env.CANCEL_ALL_OPEN === "1";
  const windowStart = process.env.CANCEL_PLACED_AFTER ?? "2026-05-02T22:08:00Z";

  let canceled = 0;
  let errored = 0;
  try {
    const sql = cancelAll
      ? `SELECT id, kalshi_order_id, client_order_id, status, placed_at
         FROM pmci.mm_orders
         WHERE status = 'open' AND kalshi_order_id IS NOT NULL
         ORDER BY placed_at`
      : `SELECT id, kalshi_order_id, client_order_id, status, placed_at
         FROM pmci.mm_orders
         WHERE status = 'open' AND kalshi_order_id IS NOT NULL
           AND placed_at > $1::timestamptz
         ORDER BY placed_at`;
    const params = cancelAll ? [] : [windowStart];
    const r = await client.query(sql, params);
    console.log(
      `[cancel-orphans] found ${r.rows.length} open order(s) (cancelAll=${cancelAll}, after=${cancelAll ? "n/a" : windowStart})`,
    );

    for (const row of r.rows) {
      try {
        await trader.cancelOrder(String(row.kalshi_order_id));
        await client.query(
          `UPDATE pmci.mm_orders SET status = 'cancelled' WHERE id = $1::bigint`,
          [row.id],
        );
        canceled += 1;
        console.log(`[cancel-orphans] canceled id=${row.id} kalshi=${row.kalshi_order_id}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 404 / not-found means it already cleared; mark canceled anyway.
        if (/not.*found|404|not_found/i.test(msg)) {
          await client.query(
            `UPDATE pmci.mm_orders SET status = 'cancelled' WHERE id = $1::bigint`,
            [row.id],
          );
          canceled += 1;
          console.log(`[cancel-orphans] already-gone id=${row.id} kalshi=${row.kalshi_order_id}`);
        } else {
          errored += 1;
          console.error(`[cancel-orphans] FAILED id=${row.id} kalshi=${row.kalshi_order_id}: ${msg}`);
        }
      }
    }
  } finally {
    await client.end().catch(() => {});
  }

  const summary = { canceled, errored };
  console.log(`[cancel-orphans] done ${JSON.stringify(summary)}`);
  process.exit(errored > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error("[cancel-orphans] fatal", e);
  process.exit(1);
});
