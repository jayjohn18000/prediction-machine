#!/usr/bin/env node
/**
 * Ensure Kalshi provider_event_map rows for phase7_migration canonical events (series_ticker fallback).
 * Env: DATABASE_URL. Optional: DRY_RUN=1
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";
import { kalshiProviderEventRefFromMarket } from "../../lib/kalshi/kalshi-series.mjs";

loadEnv();
const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(1);
}
const dry = process.env.DRY_RUN === "1";

const pemSql = `
  INSERT INTO pmci.provider_event_map (canonical_event_id, provider_id, provider_event_ref, confidence, match_method)
  VALUES ($1::uuid, $2::smallint, $3, 1.0, 'phase7_kalshi_repair')
  ON CONFLICT (provider_id, provider_event_ref) DO UPDATE SET
    canonical_event_id = EXCLUDED.canonical_event_id,
    match_method = EXCLUDED.match_method
`;

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  const { rows: ces } = await client.query(
    `SELECT id FROM pmci.canonical_events WHERE source_annotation = 'phase7_migration'`,
  );
  let upserts = 0;
  for (const ce of ces || []) {
    const { rows: legs } = await client.query(
      `SELECT pm.*, pr.code AS provider_code
       FROM pmci.canonical_markets cm
       JOIN pmci.provider_market_map pmm ON pmm.canonical_market_id = cm.id
         AND (pmm.removed_at IS NULL) AND (pmm.status IS NULL OR pmm.status = 'active')
       JOIN pmci.provider_markets pm ON pm.id = pmm.provider_market_id
       JOIN pmci.providers pr ON pr.id = pm.provider_id
       WHERE cm.canonical_event_id = $1::uuid`,
      [ce.id],
    );
    for (const m of legs) {
      if (String(m.provider_code || "").toLowerCase() !== "kalshi") continue;
      const pref = kalshiProviderEventRefFromMarket(m);
      if (!pref) continue;
      if (dry) {
        upserts++;
        continue;
      }
      await client.query(pemSql, [ce.id, m.provider_id, pref]);
      upserts++;
    }
  }
  console.log(JSON.stringify({ kalshi_pem_operations: upserts, dry_run: dry }));
} finally {
  await client.end();
}
