/**
 * D5.2 — Guard before bulk inactivating provider_markets. Call before
 * UPDATE pmci.provider_markets SET status = 'inactive' WHERE ...
 * @param {object} db - pg Client or { query: (sql, params) => Promise }
 * @param {string[]|number[]} marketIds - IDs to check
 * @throws {Error} if any of the markets have live snapshots or links
 */
import { loadEnv } from '../../src/platform/env.mjs';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function checkBeforeInactivate(db, marketIds) {
  if (!marketIds?.length) return;
  const ids = marketIds.map((id) => Number(id)).filter((n) => Number.isFinite(n));
  if (ids.length === 0) return;
  const { rows } = await db.query(
    `SELECT pm.id, COUNT(DISTINCT pms.id) AS snapshots, COUNT(DISTINCT ml.id) AS links
     FROM pmci.provider_markets pm
     LEFT JOIN pmci.provider_market_snapshots pms ON pms.provider_market_id = pm.id
     LEFT JOIN pmci.market_links ml ON ml.provider_market_id = pm.id AND ml.status = 'active'
     WHERE pm.id = ANY($1::bigint[])
     GROUP BY pm.id
     HAVING COUNT(DISTINCT pms.id) > 0 OR COUNT(DISTINCT ml.id) > 0`,
    [ids],
  );
  if (rows.length > 0) {
    const idList = rows.map((r) => r.id).join(', ');
    throw new Error(
      `Cannot inactivate ${rows.length} markets — they have live snapshots or links. Review: ${idList}`,
    );
  }
}

/**
 * E1.6 CLI: read-only preflight before scripts/stale-cleanup.mjs.
 * Ensures no past-due sports markets (by close_time or game_date) still carry accepted/pending market_links.
 */
async function runInactiveGuardCli() {
  loadEnv();
  if (!process.env.DATABASE_URL) {
    console.error('inactive-guard: DATABASE_URL is required');
    process.exit(1);
  }
  const { Client } = pg;
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const closeRes = await c.query(`
      SELECT count(*)::int AS ct
      FROM pmci.provider_markets pm
      JOIN pmci.market_links ml ON ml.provider_market_id = pm.id
      WHERE pm.category = 'sports'
        AND pm.status = 'active'
        AND pm.close_time IS NOT NULL
        AND pm.close_time < NOW()
        AND ml.status = 'active'
    `);
    const gameRes = await c.query(`
      SELECT count(*)::int AS ct
      FROM pmci.provider_markets pm
      JOIN pmci.market_links ml ON ml.provider_market_id = pm.id
      WHERE pm.category = 'sports'
        AND coalesce(pm.status,'') IN ('active','open')
        AND pm.game_date IS NOT NULL
        AND pm.game_date < CURRENT_DATE
        AND ml.status = 'active'
    `);
    const nClose = Number(closeRes.rows[0]?.ct ?? 0);
    const nGame = Number(gameRes.rows[0]?.ct ?? 0);
    if (nClose > 0 || nGame > 0) {
      console.error(
        `inactive-guard FAIL: ${nClose} past-close + ${nGame} past-game_date stale sports rows have accepted/pending market_links — fix links before cleanup.`,
      );
      process.exit(1);
    }
    console.log('inactive-guard OK: 0 past-close and 0 past-game_date stale sports markets have accepted/pending market_links.');
    console.log('Safe to run scripts/stale-cleanup.mjs (closes past close_time and past game_date rows without such links).');
  } finally {
    await c.end();
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  runInactiveGuardCli().catch((err) => {
    console.error('inactive-guard:', err.message);
    process.exit(1);
  });
}
