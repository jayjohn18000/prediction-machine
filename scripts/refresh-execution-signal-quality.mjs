#!/usr/bin/env node
/**
 * Refresh the execution_signal_quality materialized view.
 *
 * Intended as a manual/operational helper (or scheduled job) rather than
 * something run on every request. Safe to wire into CI or cron as needed.
 *
 * Env: DATABASE_URL (Postgres connection string; uses src/platform/env.mjs)
 */

import pg from 'pg';
import { loadEnv } from '../src/platform/env.mjs';

const { Client } = pg;

loadEnv();

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL is required. Set it in .env');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });

  console.log('Refreshing public.execution_signal_quality ...');

  const startedAt = Date.now();

  try {
    await client.connect();
    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY public.execution_signal_quality;');
  } finally {
    await client.end();
  }

  const ms = Date.now() - startedAt;
  console.log(`Refresh complete in ${ms} ms.`);
}

main().catch((err) => {
  console.error('Error refreshing execution_signal_quality:', err.message);
  process.exit(1);
});

