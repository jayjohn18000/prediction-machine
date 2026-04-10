/**
 * A3: Clear stale-active sports markets + verify no links would be broken.
 * PMCI invariant: run inactive-guard check first. Since the coverage API requires
 * auth, we verify directly in DB that no stale sports markets have active links.
 */
import { loadEnv } from '/Users/jaylenjohnson/prediction-machine/src/platform/env.mjs';
import pg from 'pg';

loadEnv();
const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const DRY_RUN = process.argv.includes('--dry-run');

// Guard: verify stale sports markets have no active market_links
const guardCheck = await c.query(`
  SELECT count(*) ct
  FROM pmci.provider_markets pm
  JOIN pmci.market_links ml ON ml.provider_market_id = pm.id
  WHERE pm.category = 'sports'
    AND pm.status = 'active'
    AND pm.close_time IS NOT NULL
    AND pm.close_time < NOW()
    AND ml.status IN ('accepted','pending')
`);
const linkedStaleCount = Number(guardCheck.rows[0].ct);
if (linkedStaleCount > 0) {
  console.error(`GUARD FAIL: ${linkedStaleCount} stale sports markets have active market_links — aborting.`);
  process.exit(1);
}
console.log(`Guard OK: 0 stale sports markets have active market_links.`);

// Dry-run count
const countRes = await c.query(`
  SELECT count(*) ct
  FROM pmci.provider_markets
  WHERE category = 'sports'
    AND status = 'active'
    AND close_time IS NOT NULL
    AND close_time < NOW()
`);
const staleCount = Number(countRes.rows[0].ct);
console.log(`Stale active sports markets to close: ${staleCount}`);

if (DRY_RUN) {
  console.log('Dry-run mode — no changes made.');
  await c.end();
  process.exit(0);
}

// Apply the update
const updateRes = await c.query(`
  UPDATE pmci.provider_markets
  SET status = 'closed'
  WHERE category = 'sports'
    AND status = 'active'
    AND close_time IS NOT NULL
    AND close_time < NOW()
`);
console.log(`Updated ${updateRes.rowCount} rows to status='closed'.`);

await c.end();
