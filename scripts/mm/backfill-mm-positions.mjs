#!/usr/bin/env node
import "dotenv/config";

/**
 * Per-market full recompute of pmci.mm_positions from pmci.mm_fills.
 *
 * Safe to run any time — including while the orchestrator is live and ingesting fills:
 * `recomputeMmPositionForMarket` takes a per-market `pg_advisory_xact_lock` so concurrent
 * live writes serialize against the backfill on a per-market basis. No DELETE; idempotent.
 */
import { createPgClient } from "../../lib/mm/order-store.mjs";
import { recomputeMmPositionForMarket } from "../../lib/mm/position-store.mjs";

async function main() {
  const client = createPgClient();
  await client.connect();
  /** @type {Array<{ market_id: number, fills_seen: number, net_contracts: number }>} */
  const summary = [];
  try {
    const res = await client.query(
      `
      SELECT DISTINCT market_id
      FROM pmci.mm_fills
      ORDER BY market_id ASC
      `,
    );
    const markets = (res.rows ?? []).map((r) => Number(r.market_id));
    for (const m of markets) {
      const out = await recomputeMmPositionForMarket(client, m);
      summary.push({
        market_id: out.market_id,
        fills_seen: out.fills_seen,
        net_contracts: out.net_contracts,
      });
    }
    console.log(
      JSON.stringify({
        ok: true,
        markets_recomputed: summary.length,
        summary,
      }),
    );
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error("[backfill-mm-positions]", err);
  process.exit(1);
});
