#!/usr/bin/env node
/**
 * PMCI smoke check: print counts and sample refs. Exit non-zero if provider_markets == 0.
 * Use after observer runs to confirm PMCI tables are populated.
 * Env: DATABASE_URL
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  try {
    const env = fs.readFileSync(envPath, 'utf8');
    env.split('\n').forEach((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    });
  } catch (_) {}
}
loadEnv();

const SQL_COUNTS = `
  SELECT
    (SELECT COUNT(*)::bigint FROM pmci.provider_markets) AS provider_markets,
    (SELECT COUNT(*)::bigint FROM pmci.provider_market_snapshots) AS snapshots,
    (SELECT COUNT(*)::bigint FROM pmci.market_families) AS families,
    (SELECT COUNT(*)::bigint FROM pmci.v_market_links_current) AS current_links;
`;
const SQL_TOP_REFS = `
  SELECT p.code, pm.provider_market_ref
  FROM pmci.provider_markets pm
  JOIN pmci.providers p ON p.id = pm.provider_id
  ORDER BY p.code, pm.id
  LIMIT 20;
`;

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL is required. Set it in .env');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const countRes = await client.query(SQL_COUNTS);
    const row = countRes.rows?.[0] || {};
    const providerMarkets = Number(row.provider_markets ?? 0);
    const snapshots = Number(row.snapshots ?? 0);
    const families = Number(row.families ?? 0);
    const currentLinks = Number(row.current_links ?? 0);

    console.log('PMCI smoke:');
    console.log('  provider_markets:', providerMarkets);
    console.log('  snapshots:', snapshots);
    console.log('  families:', families);
    console.log('  current_links (v_market_links_current):', currentLinks);

    const refRes = await client.query(SQL_TOP_REFS);
    const byProvider = new Map();
    for (const r of refRes.rows || []) {
      const code = r.code;
      if (!byProvider.has(code)) byProvider.set(code, []);
      byProvider.get(code).push(r.provider_market_ref);
    }
    for (const [code, refs] of byProvider) {
      const top5 = refs.slice(0, 5);
      console.log(`  top provider_market_ref (${code}):`, top5.join(', ') || '(none)');
    }

    if (providerMarkets === 0) {
      console.error('\nprovider_markets is 0. Run the observer with DATABASE_URL set so it writes to PMCI, then run this again.');
      process.exit(1);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
