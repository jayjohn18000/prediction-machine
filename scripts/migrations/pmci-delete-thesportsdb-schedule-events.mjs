#!/usr/bin/env node
/**
 * Remove schedule rows ingested from TheSportsDB (before league-id / fetch fixes).
 * Env: DATABASE_URL. Optional: DRY_RUN=1
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();
const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(1);
}
const dry = process.env.DRY_RUN === "1";

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const sel = await client.query(
    `SELECT id, slug, title FROM pmci.canonical_events WHERE external_source = 'thesportsdb'`,
  );
  console.log(`Found ${sel.rows?.length ?? 0} canonical_events with external_source=thesportsdb`);
  if (dry) {
    console.log("DRY_RUN=1 — no delete");
    process.exit(0);
  }
  const del = await client.query(
    `DELETE FROM pmci.canonical_events WHERE external_source = 'thesportsdb' RETURNING id`,
  );
  console.log(`Deleted ${del.rowCount} rows`);
} finally {
  await client.end();
}
