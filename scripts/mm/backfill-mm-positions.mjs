#!/usr/bin/env node
import "dotenv/config";

/**
 * Replay all pmci.mm_fills in chronological order through upsertPositionFromMmFill
 * so mm_positions catches up after deploy / historical gaps.
 */
import { createPgClient } from "../../lib/mm/order-store.mjs";
import { upsertPositionFromMmFill } from "../../lib/mm/position-store.mjs";

async function main() {
  const client = createPgClient();
  await client.connect();
  let replayed = 0;
  let markets = /** @type {Set<number>} */ (new Set());
  try {
    await client.query(`DELETE FROM pmci.mm_positions`);
    const fills = await client.query(
      `
      SELECT id, market_id, observed_at, price_cents, size_contracts, side
      FROM pmci.mm_fills
      ORDER BY observed_at ASC, id ASC
      `,
    );
    const rows = fills.rows ?? [];
    for (const r of rows) {
      await upsertPositionFromMmFill(client, r.market_id, {
        side: r.side,
        size_contracts: Number(r.size_contracts),
        price_cents: Number(r.price_cents),
        observed_at: r.observed_at,
      });
      replayed += 1;
      markets.add(Number(r.market_id));
    }
    console.log(
      JSON.stringify({
        ok: true,
        fills_replayed: replayed,
        distinct_markets: [...markets.values()].sort((a, b) => a - b),
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
