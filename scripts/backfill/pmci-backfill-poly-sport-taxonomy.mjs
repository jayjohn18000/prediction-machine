#!/usr/bin/env node
/**
 * Phase G: re-resolve sport for all active/open Polymarket sports markets using
 * resolvePolymarketSport (alias map + title inference). Safe to re-run.
 */
import { loadEnv } from "../../src/platform/env.mjs";
import pg from "pg";
import { resolvePolymarketSport } from "../../lib/ingestion/services/sport-inference.mjs";

loadEnv();
const { Client } = pg;

const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const { rows } = await c.query(`
  SELECT pm.id, pm.title,
         pm.metadata->>'tag_slug' AS tag_slug,
         pm.metadata->>'tag_id' AS tag_id
  FROM pmci.provider_markets pm
  JOIN pmci.providers p ON pm.provider_id = p.id
  WHERE p.code = 'polymarket'
    AND pm.category = 'sports'
    AND coalesce(pm.status,'') IN ('active','open')
`);

let updated = 0;
for (const row of rows) {
  const tagBits = [row.tag_slug, row.tag_id].filter(Boolean).map(String);
  const sport = resolvePolymarketSport(tagBits, row.title);
  await c.query(`UPDATE pmci.provider_markets SET sport = $1 WHERE id = $2`, [sport, row.id]);
  updated++;
}

console.log(`pmci-backfill-poly-sport-taxonomy: updated ${updated} rows`);
await c.end();
