#!/usr/bin/env node
/**
 * PMCI ingestion probe: confirm DATABASE_URL points at a DB with PMCI schema
 * and show whether ingestion has run (provider_markets, snapshots, latest timestamp).
 * Use after running the observer to verify it wrote to the same DB.
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
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
