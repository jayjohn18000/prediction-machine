/**
 * A3: Clear stale-active sports markets + verify no links would be broken.
 * PMCI invariant: run inactive-guard check first. Since the coverage API requires
 * auth, we verify directly in DB that no stale sports markets have active links.
 */
import { loadEnv } from '../src/platform/env.mjs';
import pg from 'pg';

loadEnv();
const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const DRY_RUN = process.argv.includes('--dry-run');

// Guard: verify past-close sports markets have no active market_links
const guardCheck = await c.query(`
  SELECT count(*) ct
  FROM pmci.provider_markets pm
  JOIN pmci.market_links ml ON ml.provider_market_id = pm.id
  WHERE pm.category = 'sports'
    AND coalesce(pm.status,'') IN ('active','open')
    AND pm.close_time IS NOT NULL
    AND pm.close_time < NOW()
    AND ml.status = 'active'
`);
const linkedStaleCount = Number(guardCheck.rows[0].ct);
if (linkedStaleCount > 0) {
  console.error(`GUARD FAIL: ${linkedStaleCount} past-close sports markets have active market_links — aborting.`);
  process.exit(1);
}
console.log(`Guard OK: 0 past-close sports markets have active market_links.`);

// Dry-run count — close_time past
const countRes = await c.query(`
  SELECT count(*) ct
  FROM pmci.provider_markets
  WHERE category = 'sports'
    AND coalesce(status,'') IN ('active','open')
    AND close_time IS NOT NULL
    AND close_time < NOW()
`);
const staleCount = Number(countRes.rows[0].ct);
console.log(`[phase close_time] Stale sports markets to close: ${staleCount}`);

const countGame = await c.query(`
  SELECT count(*) ct
  FROM pmci.provider_markets pm
  WHERE pm.category = 'sports'
    AND coalesce(pm.status,'') IN ('active','open')
    AND pm.game_date IS NOT NULL
    AND pm.game_date < CURRENT_DATE
    AND NOT EXISTS (
      SELECT 1 FROM pmci.market_links ml
      WHERE ml.provider_market_id = pm.id AND ml.status = 'active'
    )
`);
const staleGameCount = Number(countGame.rows[0].ct);
console.log(`[phase game_date] Past game_date sports rows to close (no active links): ${staleGameCount}`);

if (DRY_RUN) {
  console.log('Dry-run mode — no changes made.');
  await c.end();
  process.exit(0);
}

const updateRes = await c.query(`
  UPDATE pmci.provider_markets
  SET status = 'closed'
  WHERE category = 'sports'
    AND coalesce(status,'') IN ('active','open')
    AND close_time IS NOT NULL
    AND close_time < NOW()
`);
console.log(`[phase close_time] Updated ${updateRes.rowCount} rows to status='closed'.`);

const updateGame = await c.query(`
  UPDATE pmci.provider_markets pm
  SET status = 'closed'
  WHERE pm.category = 'sports'
    AND coalesce(pm.status,'') IN ('active','open')
    AND pm.game_date IS NOT NULL
    AND pm.game_date < CURRENT_DATE
    AND NOT EXISTS (
      SELECT 1 FROM pmci.market_links ml
      WHERE ml.provider_market_id = pm.id AND ml.status = 'active'
    )
`);
console.log(`[phase game_date] Updated ${updateGame.rowCount} rows to status='closed' (unlinkable stale only).`);

await c.end();
