/**
 * E1.5 backfill: reclassify sports markets with sport='unknown' using
 * inferSportFromKalshiTicker against the stored series_ticker in metadata.
 * Safe to re-run — only updates rows currently 'unknown'.
 */
import { loadEnv } from '../src/platform/env.mjs';
import pg from '../node_modules/pg/lib/index.js';
import { inferSportFromKalshiTicker } from '../lib/ingestion/services/sport-inference.mjs';

loadEnv();
const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

// Fetch all unknown-sport active/open kalshi markets with their titles + series_ticker
const { rows } = await c.query(`
  SELECT pm.id, pm.title, pm.metadata->>'series_ticker' as series_ticker
  FROM pmci.provider_markets pm
  JOIN pmci.providers p ON pm.provider_id = p.id
  WHERE p.code = 'kalshi'
    AND pm.category = 'sports'
    AND (pm.sport IS NULL OR pm.sport = 'unknown')
    AND coalesce(pm.status,'') IN ('active','open')
`);

console.log('[backfill] Found ' + rows.length + ' unknown-sport Kalshi markets to reclassify');

let updated = 0;
let stillUnknown = 0;
const sportCounts = {};

for (const row of rows) {
  const sport = inferSportFromKalshiTicker(row.title, row.series_ticker);
  sportCounts[sport] = (sportCounts[sport] || 0) + 1;
  if (sport !== 'unknown') {
    await c.query(
      'UPDATE pmci.provider_markets SET sport = $1 WHERE id = $2',
      [sport, row.id]
    );
    updated++;
  } else {
    stillUnknown++;
  }
}

console.log('[backfill] Updated ' + updated + ' rows. Still unknown: ' + stillUnknown);
console.log('[backfill] Sport distribution:', JSON.stringify(sportCounts, null, 2));

// Verify final unknown count
const { rows: verify } = await c.query(`
  SELECT COUNT(*) as ct FROM pmci.provider_markets
  WHERE category='sports' AND (sport IS NULL OR sport='unknown')
  AND coalesce(status,'') IN ('active','open')
`);
console.log('[backfill] Final unknown_sport count: ' + verify[0].ct);

await c.end();
