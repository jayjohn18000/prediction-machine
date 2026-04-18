#!/usr/bin/env node
/**
 * One-screen digest for cron / logs. Uses shared queries from scripts/lib/pmci-status-queries.mjs.
 * Schedule via admin job `status-digest` + pg_cron → pmci-job-runner.
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";
import { fetchPmciStatusBundle } from "../lib/pmci-status-queries.mjs";

loadEnv();
const { Client } = pg;

async function main() {
  const baseUrl =
    process.env.PMCI_API_URL?.trim() ||
    process.env.PMCI_SERVER_URL?.trim() ||
    "https://pmci-api.fly.dev";

  if (!process.env.DATABASE_URL) {
    console.error("pmci-daily-digest: DATABASE_URL required");
    process.exit(1);
  }

  let freshness = { status: "unknown" };
  try {
    const r = await fetch(`${baseUrl}/v1/health/freshness`);
    freshness = await r.json();
  } catch (e) {
    freshness = { status: "error", error: String(e?.message || e) };
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let bundle;
  try {
    bundle = await fetchPmciStatusBundle(client);
  } finally {
    await client.end();
  }

  const ts = new Date().toISOString();
  const lines = [
    `[pmci-digest] ${ts}`,
    `  API freshness: ${freshness?.status ?? "?"} lag_seconds=${freshness?.lag_seconds ?? "?"}`,
    `  markets=${bundle.smoke.provider_markets} snapshots=${bundle.smoke.snapshots} families=${bundle.smoke.families} links=${bundle.smoke.current_links}`,
  ];
  for (const r of bundle.pending_proposals || []) {
    lines.push(`  pending proposals: ${r.category}=${r.cnt}`);
  }
  const ob = bundle.observer;
  if (ob?.cycle_at) {
    lines.push(
      `  observer: cycle_at=${ob.cycle_at} lag_s=${ob.lag_seconds ?? "?"} pairs_ok=${ob.pairs_succeeded}/${ob.pairs_attempted}`,
    );
  }
  console.log(lines.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
