#!/usr/bin/env node
/**
 * A1: Ingest settled outcomes for provider_markets in linked sports families.
 * Appends pmci.market_outcome_history on every observation; upserts pmci.market_outcomes.
 *
 * Env: DATABASE_URL
 * Flags: --dry-run (no DB writes), --limit N
 */

import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";
import { runMarketOutcomeIngest } from "../../lib/resolution/ingest-market-outcomes.mjs";

const { Client } = pg;
loadEnv();

function parseArgs(argv) {
  let dryRun = false;
  let limit = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--limit" && argv[i + 1]) {
      limit = parseInt(argv[++i], 10);
      if (Number.isNaN(limit) || limit < 1) limit = null;
    }
  }
  return { dryRun, limit };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const { dryRun, limit } = parseArgs(process.argv);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const stats = await runMarketOutcomeIngest(client, {
      dryRun,
      limit,
      log: console.log,
    });
    console.log(
      JSON.stringify(
        {
          ...stats,
          dryRun,
          limit,
        },
        null,
        2,
      ),
    );
    process.exit(stats.errors > 0 ? 1 : 0);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
