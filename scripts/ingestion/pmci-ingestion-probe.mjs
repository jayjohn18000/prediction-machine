#!/usr/bin/env node
/**
 * PMCI ingestion probe: confirm DATABASE_URL points at a DB with PMCI schema
 * and show whether ingestion has run (provider_markets, snapshots, latest timestamp).
 * Use after running the observer to verify it wrote to the same DB.
 * Env: DATABASE_URL
 */

import pg from 'pg';
import { loadEnv } from '../../src/platform/env.mjs';

const { Client } = pg;
loadEnv();

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL is required. Set it in .env');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const dbRes = await client.query('SELECT current_database() AS db');
    const db = dbRes.rows?.[0]?.db ?? '(unknown)';
    console.log('Database:', db);

    try {
      const addrRes = await client.query('SELECT inet_server_addr() AS addr, inet_server_port() AS port');
      const addr = addrRes.rows?.[0]?.addr;
      const port = addrRes.rows?.[0]?.port;
      if (addr != null || port != null) {
        console.log('Server:', addr != null ? String(addr) : '?', port != null ? String(port) : '');
      }
    } catch (_) {
      // optional; some environments don't expose these
    }

    const providersRes = await client.query('SELECT id, code FROM pmci.providers ORDER BY id');
    console.log('Providers:', (providersRes.rows || []).map((r) => `${r.code}(id=${r.id})`).join(', ') || '(none)');

    const countsRes = await client.query(`
      SELECT
        (SELECT COUNT(*)::bigint FROM pmci.provider_markets) AS provider_markets,
        (SELECT COUNT(*)::bigint FROM pmci.provider_market_snapshots) AS snapshots,
        (SELECT COUNT(*)::bigint FROM pmci.market_families) AS families,
        (SELECT COUNT(*)::bigint FROM pmci.v_market_links_current) AS current_links
    `);
    const row = countsRes.rows?.[0] || {};
    const providerMarkets = Number(row.provider_markets ?? 0);
    const snapshots = Number(row.snapshots ?? 0);
    const families = Number(row.families ?? 0);
    const currentLinks = Number(row.current_links ?? 0);

    console.log('Counts: provider_markets=%d snapshots=%d families=%d current_links=%d', providerMarkets, snapshots, families, currentLinks);

    const latestRes = await client.query('SELECT max(observed_at) AS latest FROM pmci.provider_market_snapshots');
    const latest = latestRes.rows?.[0]?.latest ?? null;
    console.log('Latest snapshot:', latest != null ? String(latest) : '(none)');

    if (providerMarkets === 0) {
      console.error('\nPMCI has no ingested markets yet. Run observer with DATABASE_URL set and confirm it logs PMCI ingestion counts.');
      process.exit(1);
    }

    // D5.1 — poly_only mislabeling: canonical events labeled poly_only but with orphaned Kalshi markets
    try {
      const polyOnlyRes = await client.query(`
        SELECT ce.id, ce.title, COUNT(pm.id) AS orphaned_kalshi
        FROM pmci.canonical_events ce
        CROSS JOIN pmci.provider_markets pm
        WHERE ce.source_annotation = 'poly_only'
          AND pm.provider_id = (SELECT id FROM pmci.providers WHERE code = 'kalshi' LIMIT 1)
          AND pm.status = 'active'
          AND similarity(lower(ce.title), lower(pm.title)) > 0.4
          AND NOT EXISTS (
            SELECT 1 FROM pmci.market_links ml
            JOIN pmci.market_families mf ON mf.id = ml.family_id
            WHERE mf.canonical_event_id = ce.id
              AND ml.provider_market_id = pm.id
          )
        GROUP BY ce.id, ce.title
        HAVING COUNT(pm.id) > 0
      `);
      if (polyOnlyRes.rows?.length > 0) {
        console.error('\nWARN: poly_only event(s) have orphaned kalshi markets — review for mislabeling:', polyOnlyRes.rows.length);
        for (const r of polyOnlyRes.rows) {
          console.error('  ', r.id, r.title, 'orphaned_kalshi=', r.orphaned_kalshi);
        }
        process.exit(1);
      }
    } catch (e) {
      if (e.message?.includes('similarity') || e.message?.includes('function')) {
        console.warn('pmci:probe skip poly_only guard (pg_trgm/similarity not available):', e.message?.slice(0, 60));
      } else throw e;
    }

    // D5.2 — Inactive markets that still have snapshots or links
    const inactiveRes = await client.query(`
      SELECT pm.id, pm.provider_market_ref, pm.provider_id, pm.status,
        COUNT(DISTINCT pms.id) AS snapshot_count,
        COUNT(DISTINCT ml.id) AS link_count
      FROM pmci.provider_markets pm
      LEFT JOIN pmci.provider_market_snapshots pms ON pms.provider_market_id = pm.id
      LEFT JOIN pmci.market_links ml ON ml.provider_market_id = pm.id
      WHERE pm.status = 'inactive'
      GROUP BY pm.id, pm.provider_market_ref, pm.provider_id, pm.status
      HAVING COUNT(DISTINCT pms.id) > 0 OR COUNT(DISTINCT ml.id) > 0
    `);
    if (inactiveRes.rows?.length > 0) {
      console.error('\nWARN: inactive market(s) still have snapshots or links — do not bulk inactivate without review:', inactiveRes.rows.length);
      process.exit(1);
    }

    // D6 — Link coverage by topic
    const coverageRes = await client.query(`
      SELECT
        CASE
          WHEN pm.provider_market_ref ILIKE 'GOVPARTY%' OR pm.title ILIKE '%governor%' THEN 'governor'
          WHEN pm.provider_market_ref ILIKE 'SENATE%' OR pm.title ILIKE '%senate%' THEN 'senate'
          WHEN pm.provider_market_ref ILIKE 'PRES%' OR pm.title ILIKE '%president%' THEN 'president'
          ELSE 'other'
        END AS topic,
        pm.provider_id,
        COUNT(DISTINCT pm.id) AS total,
        COUNT(DISTINCT ml.id) AS linked,
        ROUND(COUNT(DISTINCT ml.id)::numeric / NULLIF(COUNT(DISTINCT pm.id), 0), 3) AS link_rate
      FROM pmci.provider_markets pm
      LEFT JOIN pmci.market_links ml ON ml.provider_market_id = pm.id
      WHERE pm.status = 'active'
      GROUP BY 1, 2
      ORDER BY 1, 2
    `);
    console.log('\nLink coverage by topic (D6):');
    const provByCode = new Map((providersRes.rows || []).map((r) => [r.id, r.code]));
    for (const r of coverageRes.rows || []) {
      const code = provByCode.get(r.provider_id) ?? r.provider_id;
      console.log(`  ${r.topic} ${code}: total=${r.total} linked=${r.linked} link_rate=${r.link_rate ?? 0}`);
    }
    const govSen = (coverageRes.rows || []).filter((r) => r.topic === 'governor' || r.topic === 'senate');
    const belowTarget = govSen.some((r) => Number(r.link_rate ?? 0) < 0.2);
    if (belowTarget) {
      console.warn('\nD6 gate: governor/senate link_rate below 0.20 — improve ingestion coverage (D0/D1).');
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
