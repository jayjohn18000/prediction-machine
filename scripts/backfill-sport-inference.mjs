/**
 * E1.5 / E1.6 backfill: reclassify sports markets with sport='unknown'.
 * - Kalshi: inferSportFromKalshiTicker(title, series_ticker)
 * - Polymarket: inferSportFromPolymarketTags(slugs) then title fallback (matches sports-universe)
 * Safe to re-run — only updates rows currently 'unknown'.
 */
import { loadEnv } from '../src/platform/env.mjs';
import pg from '../node_modules/pg/lib/index.js';
import {
  inferSportFromKalshiTicker,
  inferSportFromPolymarketTags,
} from '../lib/ingestion/services/sport-inference.mjs';

loadEnv();
const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

async function backfillKalshi() {
  const { rows } = await c.query(`
    SELECT pm.id, pm.title, pm.metadata->>'series_ticker' as series_ticker
    FROM pmci.provider_markets pm
    JOIN pmci.providers p ON pm.provider_id = p.id
    WHERE p.code = 'kalshi'
      AND pm.category = 'sports'
      AND (pm.sport IS NULL OR pm.sport = 'unknown')
      AND coalesce(pm.status,'') IN ('active','open')
  `);

  console.log('[backfill kalshi] Found ' + rows.length + ' unknown-sport Kalshi markets to reclassify');

  let updated = 0;
  let stillUnknown = 0;
  const sportCounts = {};

  for (const row of rows) {
    const sport = inferSportFromKalshiTicker(row.title, row.series_ticker);
    sportCounts[sport] = (sportCounts[sport] || 0) + 1;
    if (sport !== 'unknown') {
      await c.query('UPDATE pmci.provider_markets SET sport = $1 WHERE id = $2', [sport, row.id]);
      updated++;
    } else {
      stillUnknown++;
    }
  }

  console.log('[backfill kalshi] Updated ' + updated + ' rows. Still unknown: ' + stillUnknown);
  console.log('[backfill kalshi] Sport distribution:', JSON.stringify(sportCounts, null, 2));
}

async function backfillPolymarket() {
  const { rows } = await c.query(`
    SELECT pm.id, pm.title,
           pm.metadata->>'tag_slug' as tag_slug,
           pm.metadata->>'tag_id' as tag_id
    FROM pmci.provider_markets pm
    JOIN pmci.providers p ON pm.provider_id = p.id
    WHERE p.code = 'polymarket'
      AND pm.category = 'sports'
      AND (pm.sport IS NULL OR pm.sport = 'unknown')
      AND coalesce(pm.status,'') IN ('active','open')
  `);

  console.log('[backfill polymarket] Found ' + rows.length + ' unknown-sport Polymarket markets to reclassify');

  let updated = 0;
  let stillUnknown = 0;
  const sportCounts = {};

  for (const row of rows) {
    const tagBits = [row.tag_slug, row.tag_id].filter(Boolean).map(String);
    let sport = inferSportFromPolymarketTags(tagBits);
    if (sport === 'unknown') {
      sport = inferSportFromKalshiTicker(row.title);
    }
    sportCounts[sport] = (sportCounts[sport] || 0) + 1;
    if (sport !== 'unknown') {
      await c.query('UPDATE pmci.provider_markets SET sport = $1 WHERE id = $2', [sport, row.id]);
      updated++;
    } else {
      stillUnknown++;
    }
  }

  console.log('[backfill polymarket] Updated ' + updated + ' rows. Still unknown: ' + stillUnknown);
  console.log('[backfill polymarket] Sport distribution:', JSON.stringify(sportCounts, null, 2));
}

await backfillKalshi();
await backfillPolymarket();

const { rows: verify } = await c.query(`
  SELECT COUNT(*)::int as ct FROM pmci.provider_markets
  WHERE category='sports' AND (sport IS NULL OR sport='unknown')
  AND coalesce(status,'') IN ('active','open')
`);
console.log('[backfill] Final unknown_sport count (active/open sports): ' + verify[0].ct);

await c.end();
