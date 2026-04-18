#!/usr/bin/env node
/**
 * Read-only: list recent pg_cron job runs (stale-cleanup, review-*, etc.).
 * Usage: DATABASE_URL=... node scripts/ops/verify-pg-cron.mjs
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();
const { Client } = pg;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const jobs = await client.query(`
      select jobid, jobname, schedule, active from cron.job
      where jobname like 'pmci-%'
      order by jobname
    `);
    console.log("cron.job (pmci-*):\n", jobs.rows);

    const details = await client.query(`
      select jobid, job_pid, database, username, command, status, return_message,
             start_time, end_time
      from cron.job_run_details
      order by start_time desc nulls last
      limit 40
    `);
    console.log("\ncron.job_run_details (last 40):\n", details.rows);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
