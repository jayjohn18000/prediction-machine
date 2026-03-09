#!/usr/bin/env node
/**
 * Run ad-hoc SQL queries against the project database.
 * Uses DATABASE_URL from .env. Read-only. Add or edit entries in QUERIES to run more.
 */
import pg from 'pg';
import { loadEnv } from './src/platform/env.mjs';

const { Client } = pg;
loadEnv();

const QUERIES = [
  {
    name: 'Q1: edge_windows by candidate (republican-presidential-nominee-2028)',
    sql: `
SELECT
  candidate,
  COUNT(*)                    AS total_windows,
  AVG(avg_edge)               AS avg_edge,
  AVG(duration_seconds)       AS avg_duration,
  PERCENTILE_CONT(0.5)
    WITHIN GROUP (ORDER BY duration_seconds) AS median_duration,
  SUM(avg_edge)               AS total_edge_sum
FROM edge_windows
WHERE event_id = 'republican-presidential-nominee-2028'
GROUP BY candidate
ORDER BY avg_edge DESC;
`,
  },
  {
    name: 'Q2: execution_signal_calibrated (score_percentile >= 0.9)',
    sql: `
SELECT
  candidate,
  COUNT(*)               AS total_trades,
  AVG(avg_edge)          AS avg_edge,
  AVG(avg_duration_seconds) AS avg_duration
FROM execution_signal_calibrated
WHERE event_id = 'republican-presidential-nominee-2028'
  AND score_percentile >= 0.9
GROUP BY candidate
ORDER BY avg_edge DESC;
`,
  },
  {
    name: 'Q3: edge_windows duration buckets (60s, 120s, 300s)',
    sql: `
SELECT
  candidate,
  COUNT(*) FILTER (WHERE duration_seconds >= 60)  AS windows_60s,
  COUNT(*) FILTER (WHERE duration_seconds >= 120) AS windows_120s,
  COUNT(*) FILTER (WHERE duration_seconds >= 300) AS windows_300s
FROM edge_windows
WHERE event_id = 'republican-presidential-nominee-2028'
GROUP BY candidate
ORDER BY windows_60s DESC;
`,
  },
  {
    name: 'Q4: edge_windows summary by event_id (dem + rep 2028)',
    sql: `
SELECT
  event_id,
  COUNT(*)              AS total_windows,
  AVG(avg_edge)         AS avg_edge,
  AVG(duration_seconds) AS avg_duration
FROM edge_windows
WHERE event_id IN (
  'democratic-presidential-nominee-2028',
  'republican-presidential-nominee-2028'
)
GROUP BY event_id;
`,
  },
];

function formatRow(row) {
  return Object.entries(row)
    .map(([k, v]) =>
      v != null && typeof v === 'number' && !Number.isInteger(v)
        ? `${k}=${Number(v).toFixed(4)}`
        : `${k}=${v}`
    )
    .join('  ');
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL is required. Set it in .env');
    process.exit(1);
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    for (const { name, sql } of QUERIES) {
      console.log('\n' + '='.repeat(80));
      console.log(name);
      console.log('='.repeat(80));
      const res = await client.query(sql.trim());
      if (res.rows.length === 0) {
        console.log('(no rows)');
      } else {
        console.log(res.rows.map(formatRow).join('\n'));
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
