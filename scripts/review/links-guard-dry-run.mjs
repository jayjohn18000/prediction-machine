#!/usr/bin/env node
import { loadEnv } from '../../src/platform/env.mjs';
import pg from 'pg';

loadEnv();
const { Client } = pg;

function parseIds(argv) {
  const flag = argv.find((x) => x.startsWith('--ids='));
  if (!flag) return [];
  return flag
    .slice('--ids='.length)
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n));
}

async function main() {
  const ids = parseIds(process.argv.slice(2));
  if (!ids.length) {
    console.log('links:guard:dry-run usage: npm run links:guard:dry-run -- --ids=1,2,3');
    process.exit(0);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const r = await client.query(
      `SELECT pm.id, COUNT(DISTINCT pms.id) AS snapshots, COUNT(DISTINCT ml.id) AS links
       FROM pmci.provider_markets pm
       LEFT JOIN pmci.provider_market_snapshots pms ON pms.provider_market_id = pm.id
       LEFT JOIN pmci.market_links ml ON ml.provider_market_id = pm.id AND ml.status = 'active'
       WHERE pm.id = ANY($1::bigint[])
       GROUP BY pm.id
       ORDER BY pm.id`,
      [ids],
    );

    const blocked = r.rows.filter((x) => Number(x.snapshots) > 0 || Number(x.links) > 0);
    const blockedIds = new Set(blocked.map((x) => Number(x.id)));
    const safe = ids.filter((id) => !blockedIds.has(id));

    console.log(`links:guard:dry-run checked=${ids.length} blocked=${blocked.length} safe=${safe.length}`);
    if (blocked.length) {
      console.log('blocked_rows=', JSON.stringify(blocked));
    }
    if (safe.length) {
      console.log('safe_ids=', safe.join(','));
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('links:guard:dry-run FAIL:', e.message);
  process.exit(1);
});
