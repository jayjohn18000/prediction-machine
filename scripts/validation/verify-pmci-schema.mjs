#!/usr/bin/env node
/**
 * Verify PMCI schema: schema exists, required tables/columns and view exist.
 * Exits non-zero on failure. Use after db push to ensure remote matches code.
 * Env: DATABASE_URL (Postgres connection string).
 */

import pg from 'pg';
import { loadEnv } from '../../src/platform/env.mjs';

const { Client } = pg;
loadEnv();

const PMCI_TABLES = [
  'providers',
  'canonical_events',
  'canonical_markets',
  'canonical_outcomes',
  'provider_markets',
  'provider_market_snapshots',
  'market_families',
  'market_links',
  'unmatched_markets',
  'linker_runs',
  'link_gold_labels',
  'linker_run_metrics',
  'proposed_links',
  'review_decisions',
  // Observer + API request log tables (low criticality but part of pmci schema).
  'observer_heartbeats',
  'request_log',
];

const REQUIRED_COLUMNS = {
  market_links: [
    'family_id',
    'provider_id',
    'provider_market_id',
    'relationship_type',
    'status',
    'link_version',
    'confidence',
    'reasons',
    'updated_at',
    'created_at',
  ],
  provider_markets: [
    'provider_id',
    'provider_market_ref',
    'title',
    'close_time',
    'status',
    'last_seen_at',
    'election_phase',
    'subject_type',
    'volume_24h',
  ],
  provider_market_snapshots: ['provider_market_id', 'observed_at', 'price_yes'],
};

const REQUIRED_VIEW = 'v_market_links_current';

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('FAIL: DATABASE_URL is required. Set it in .env');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  const errors = [];

  try {
    await client.connect();
  } catch (err) {
    console.error('FAIL: Could not connect to database:', err.message);
    process.exit(1);
  }

  try {
    // 1) Schema pmci exists
    const schemaRes = await client.query(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
      ['pmci'],
    );
    if (!schemaRes.rows?.length) {
      errors.push('Schema pmci does not exist');
    }

    // 2) Required tables exist
    const tablesRes = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'pmci' AND table_type = 'BASE TABLE'`,
    );
    const existingTables = new Set((tablesRes.rows || []).map((r) => r.table_name));
    for (const t of PMCI_TABLES) {
      if (!existingTables.has(t)) {
        errors.push(`Table pmci.${t} does not exist`);
      }
    }

    // 3) Required columns per table
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      if (!existingTables.has(table)) continue;
      const colRes = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'pmci' AND table_name = $1`,
        [table],
      );
      const existingCols = new Set((colRes.rows || []).map((r) => r.column_name));
      for (const c of columns) {
        if (!existingCols.has(c)) {
          errors.push(`Column pmci.${table}.${c} does not exist`);
        }
      }
    }

    // 4) View pmci.v_market_links_current exists
    const viewRes = await client.query(
      `SELECT 1 FROM information_schema.views
       WHERE table_schema = 'pmci' AND table_name = $1`,
      [REQUIRED_VIEW],
    );
    if (!viewRes.rows?.length) {
      errors.push(`View pmci.${REQUIRED_VIEW} does not exist`);
    }
  } finally {
    await client.end();
  }

  // Report
  if (errors.length === 0) {
    console.log('PMCI schema verification: PASS');
    console.log('  - Schema pmci exists');
    console.log('  - Required tables present:', PMCI_TABLES.length);
    console.log('  - Required columns present for market_links, provider_markets, provider_market_snapshots');
    console.log('  - View pmci.v_market_links_current exists');
    process.exit(0);
  }

  console.error('PMCI schema verification: FAIL');
  errors.forEach((e) => console.error('  -', e));
  console.error('\nIf migrations were applied and this still fails: re-run the PMCI migration in Supabase SQL Editor, or create a new migration that adds the missing objects.');
  process.exit(1);
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
