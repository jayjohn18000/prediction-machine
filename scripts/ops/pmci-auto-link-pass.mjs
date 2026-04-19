#!/usr/bin/env node
/**
 * Phase G autonomous linking pass — run via cron (pmci-job-runner) or manually.
 * Env: DATABASE_URL. Optional: PMCI_AUTO_LINK_BATCH, PMCI_AUTO_LINK_MIN_SCORE.
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";
import { runAutoLinkPass } from "../../lib/matching/auto-linker.mjs";

loadEnv();
const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const stats = await runAutoLinkPass(client);
  console.log("pmci-auto-link-pass:", JSON.stringify(stats));
} finally {
  await client.end();
}
