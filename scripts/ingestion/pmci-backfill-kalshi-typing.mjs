#!/usr/bin/env node
import pg from 'pg';
import { loadEnv } from '../../src/platform/env.mjs';

const { Client } = pg;
loadEnv();

function inferElectionPhase(ticker, title) {
  const t = String(title || '').toLowerCase();
  const tick = String(ticker || '').toUpperCase();
  if (/primary/i.test(t) || /-PRI-/.test(tick)) return 'primary';
  if (/runoff/i.test(t)) return 'runoff';
  if (/special/i.test(t)) return 'special';
  return 'general';
}

function inferSubjectType(ticker, title) {
  const t = String(title || '').toLowerCase();
  const tick = String(ticker || '').toUpperCase();
  if (/^GOVPARTY|^SENATE.*-REP$|^SENATE.*-DEM$/.test(tick)) return 'party';
  if (/nominate|appointment|appoint/i.test(t)) return 'appointment';
  if (/policy|rate|decision|bill|act\b/i.test(t)) return 'policy';
  return 'candidate';
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const providerRes = await client.query("SELECT id FROM pmci.providers WHERE code='kalshi' LIMIT 1");
    const providerId = providerRes.rows?.[0]?.id;
    if (!providerId) throw new Error('kalshi provider missing in pmci.providers');

    const rowsRes = await client.query(
      `SELECT id, provider_market_ref, title
       FROM pmci.provider_markets
       WHERE provider_id = $1
         AND (election_phase IS NULL OR subject_type IS NULL)`,
      [providerId],
    );

    const rows = rowsRes.rows || [];
    let updated = 0;

    for (const r of rows) {
      const ep = inferElectionPhase(r.provider_market_ref, r.title);
      const st = inferSubjectType(r.provider_market_ref, r.title);
      const u = await client.query(
        `UPDATE pmci.provider_markets
         SET election_phase = COALESCE(election_phase, $2),
             subject_type = COALESCE(subject_type, $3)
         WHERE id = $1`,
        [r.id, ep, st],
      );
      updated += u.rowCount || 0;
    }

    console.log(`pmci:backfill:kalshi-typing scanned=${rows.length} updated=${updated}`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('pmci:backfill:kalshi-typing FAIL:', e.message);
  process.exit(1);
});
