#!/usr/bin/env node
/**
 * Sanity check: count Polymarket provider_markets where title or provider_market_ref
 * contains "nominee" or "2028". Use to confirm whether nominee markets exist in DB
 * (if 0, tag feed isn't giving them or topic classifier isn't seeing them).
 *
 * Usage: node scripts/pmci-count-poly-nominee.mjs
 * Env: DATABASE_URL (required)
 */

import pg from 'pg';
import { loadEnv } from '../src/platform/env.mjs';

const { Client } = pg;
loadEnv();

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const polyIdRes = await client.query(
      `SELECT id FROM pmci.providers WHERE code = 'polymarket'`,
    );
    const polyId = polyIdRes.rows?.[0]?.id;
    if (!polyId) {
      console.log('Polymarket provider not found.');
      return;
    }

    const countRes = await client.query(
      `SELECT COUNT(*) AS n FROM pmci.provider_markets
       WHERE provider_id = $1
         AND (title ILIKE '%nominee%' OR provider_market_ref ILIKE '%nominee%'
              OR title ILIKE '%2028%' OR provider_market_ref ILIKE '%2028%')`,
      [polyId],
    );
    const count = Number(countRes.rows?.[0]?.n ?? 0);

    const totalRes = await client.query(
      `SELECT COUNT(*) AS n FROM pmci.provider_markets WHERE provider_id = $1`,
      [polyId],
    );
    const total = Number(totalRes.rows?.[0]?.n ?? 0);

    console.log(
      'pmci:count-poly-nominee polymarket provider_markets: total=%d with_nominee_or_2028=%d',
      total,
      count,
    );
    if (count === 0 && total > 0) {
      console.log(
        '  → No nominee/2028 markets in DB: tag feed may not include them, or expand ingestion (e.g. PMCI_POLITICS_POLY_SLUG_KEYWORDS).',
      );
    } else if (count > 0) {
      console.log('  → Nominee/2028 markets present; if poly_all_by_topic.nominee=0, check extractTopicKey.');
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
