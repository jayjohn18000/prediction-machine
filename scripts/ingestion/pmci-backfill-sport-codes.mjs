#!/usr/bin/env node
/**
 * Backfill sport_code for existing sports markets in pmci.provider_markets.
 * Scans rows where category='sports' and sport_code is NULL, then infers
 * the code from tags/titles using the sport-inference module.
 *
 * Usage:
 *   node scripts/ingestion/pmci-backfill-sport-codes.mjs [--dry-run]
 *
 * Options:
 *   --dry-run   Print what would be updated without making changes
 */
import pg from 'pg';
import { loadEnv } from '../../src/platform/env.mjs';
import {
  inferSportFromPolymarketTags,
  inferSportFromKalshiTicker,
  SPORT_CODES,
} from '../../lib/ingestion/sports-universe.mjs';

const { Client } = pg;
loadEnv();

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const providerRes = await client.query(
      "SELECT id, code FROM pmci.providers WHERE code IN ('kalshi', 'polymarket')"
    );
    const providers = new Map(providerRes.rows.map((r) => [r.code, r.id]));
    const kalshiId = providers.get('kalshi');
    const polymarketId = providers.get('polymarket');

    if (!kalshiId && !polymarketId) {
      console.log('pmci:backfill:sport-codes no providers found, skipping');
      return;
    }

    const rowsRes = await client.query(
      `SELECT id, provider_id, provider_market_ref, title, metadata
       FROM pmci.provider_markets
       WHERE LOWER(category) = 'sports'
         AND (sport_code IS NULL OR sport_code = '' OR sport_code = $1)`,
      [SPORT_CODES.UNKNOWN]
    );

    const rows = rowsRes.rows || [];
    console.log(`pmci:backfill:sport-codes found ${rows.length} rows to process`);

    let updated = 0;
    let skipped = 0;

    for (const r of rows) {
      let sportCode = SPORT_CODES.UNKNOWN;

      if (r.provider_id === kalshiId) {
        const ticker = r.metadata?.series_ticker || r.provider_market_ref || '';
        sportCode = inferSportFromKalshiTicker(ticker);
      } else if (r.provider_id === polymarketId) {
        const tags = r.metadata?.tags || [];
        const title = r.title || '';
        const result = inferSportFromPolymarketTags(tags, title);
        sportCode = result.sportCode;
      }

      if (sportCode === SPORT_CODES.UNKNOWN) {
        skipped += 1;
        continue;
      }

      if (DRY_RUN) {
        console.log(`[DRY-RUN] Would update id=${r.id} ref=${r.provider_market_ref} -> sport_code=${sportCode}`);
        updated += 1;
        continue;
      }

      const updateRes = await client.query(
        `UPDATE pmci.provider_markets
         SET sport_code = $2
         WHERE id = $1 AND (sport_code IS NULL OR sport_code = '' OR sport_code = $3)`,
        [r.id, sportCode, SPORT_CODES.UNKNOWN]
      );
      updated += updateRes.rowCount || 0;
    }

    console.log(`pmci:backfill:sport-codes scanned=${rows.length} updated=${updated} skipped=${skipped}${DRY_RUN ? ' (dry-run)' : ''}`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('pmci:backfill:sport-codes FAIL:', e.message);
  process.exit(1);
});
