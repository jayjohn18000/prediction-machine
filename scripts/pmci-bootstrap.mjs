#!/usr/bin/env node

/**
 * PMCI bootstrap CLI.
 * Validates that the projection pipeline is ready end-to-end.
 *
 * Steps:
 * 1. Env check (DATABASE_URL).
 * 2. DB connection.
 * 3. Provider IDs (kalshi, polymarket).
 * 4. provider_markets count.
 * 5. provider_market_snapshots count.
 * 6. market_families count.
 * 7. v_market_links_current active links count.
 * 8. Snapshot freshness vs MAX_LAG_SECONDS.
 *
 * Exit code 1 is used only for hard failures (missing env, connection failure,
 * missing providers, no provider_markets). Other issues are surfaced as WARN.
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { getProviderIds } from "../lib/pmci-ingestion.mjs";

const { Client } = pg;

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  try {
    const env = fs.readFileSync(envPath, "utf8");
    env.split("\n").forEach((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    });
  } catch {
    // Ignore missing .env – environment may be provided by the shell.
  }
}

loadEnv();

// CLI uses PMCI_MAX_LAG_SECONDS if set; otherwise fallback to 120 seconds.
const MAX_LAG_SECONDS = Number(process.env.PMCI_MAX_LAG_SECONDS ?? "120");

async function runChecks(client) {
  const providerIds = await getProviderIds(client);
  if (providerIds == null) {
    throw new Error(
      "ERROR: pmci.providers missing 'kalshi' or 'polymarket'. Run migrations:\n" +
        "npx supabase db push",
    );
  }

  // Step 4 — Provider markets count
  const pmRes = await client.query(
    "SELECT COUNT(*)::bigint AS count FROM pmci.provider_markets",
  );
  const providerMarkets = Number(pmRes.rows?.[0]?.count ?? 0);
  if (!Number.isFinite(providerMarkets) || providerMarkets === 0) {
    throw new Error(
      "ERROR: No provider_markets found. The observer has not run yet.\n" +
        "Fix: Set DATABASE_URL and run: npm run start\n" +
        "Wait for at least 1 full cycle (log: 'PMCI ingestion: markets_upserted=...')",
    );
  }
  console.log(`✓ provider_markets: ${providerMarkets}`);

  // Step 5 — Snapshots count
  const snapRes = await client.query(
    "SELECT COUNT(*)::bigint AS count FROM pmci.provider_market_snapshots",
  );
  const snapshotsCount = Number(snapRes.rows?.[0]?.count ?? 0);
  if (!Number.isFinite(snapshotsCount) || snapshotsCount === 0) {
    console.warn(
      "WARN: No snapshots yet. Observer may still be on first cycle. Continue watching logs.",
    );
  } else {
    console.log(`✓ provider_market_snapshots: ${snapshotsCount}`);
  }

  // Step 6 — Families count
  const famRes = await client.query(
    "SELECT COUNT(*)::bigint AS count FROM pmci.market_families",
  );
  const familiesCount = Number(famRes.rows?.[0]?.count ?? 0);
  if (!Number.isFinite(familiesCount) || familiesCount === 0) {
    console.warn(
      "WARN: No market families. Run: npm run seed:pmci\n" +
        "       (Families link Kalshi↔Polymarket markets for divergence signals)",
    );
  } else {
    console.log(`✓ market_families: ${familiesCount}`);
  }

  // Step 7 — Active links count
  const linksRes = await client.query(
    "SELECT COUNT(*)::bigint AS count FROM pmci.v_market_links_current",
  );
  const linksCount = Number(linksRes.rows?.[0]?.count ?? 0);
  if (familiesCount > 0 && (!Number.isFinite(linksCount) || linksCount === 0)) {
    console.warn(
      "WARN: Families exist but no active links found in v_market_links_current. Check migration applied correctly.",
    );
  } else if (linksCount > 0) {
    console.log(`✓ active links: ${linksCount}`);
  }

  // Step 8 — Freshness check
  const freshRes = await client.query(
    "SELECT EXTRACT(EPOCH FROM (now() - MAX(observed_at)))::int AS lag_seconds FROM pmci.provider_market_snapshots",
  );
  const lagRaw = freshRes.rows?.[0]?.lag_seconds;
  const lagSeconds =
    typeof lagRaw === "number"
      ? lagRaw
      : lagRaw == null
        ? null
        : Number(lagRaw);

  if (typeof lagSeconds === "number") {
    if (lagSeconds > MAX_LAG_SECONDS) {
      console.warn(
        `WARN: Last snapshot is ${lagSeconds}s ago. Observer may not be running.\n` +
          "       Run: npm run start",
      );
    } else {
      console.log(`✓ snapshot freshness: ${lagSeconds}s ago`);
    }
  } else {
    console.warn(
      "WARN: Unable to compute snapshot freshness (no snapshots yet). Observer may still be initializing.",
    );
  }

  return {
    familiesCount,
    linksCount,
    snapshotsCount,
  };
}

async function main() {
  // Step 1 — Env check
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error(
      "ERROR: DATABASE_URL is not set. PMCI requires a direct Postgres connection.\n" +
        "Add DATABASE_URL to your .env file (Supabase Dashboard → Settings → Database → Connection string).",
    );
    process.exit(1);
  }

  // Step 2 — DB connection
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (err) {
    console.error(
      `ERROR: Failed to connect to DATABASE_URL. ${err?.message ?? "Unknown error"}`,
    );
    try {
      await client.end();
    } catch {
      // ignore
    }
    process.exit(1);
  }

  let exitCode = 0;
  let summary = null;

  try {
    summary = await runChecks(client);
  } catch (err) {
    exitCode = 1;
    if (err?.message) {
      console.error(err.message);
    } else {
      console.error(err);
    }
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }

    if (exitCode === 0 && summary) {
      const { familiesCount, linksCount, snapshotsCount } = summary;
      console.log(
        `\n✓ Projection pipeline is ready.\n  Families: ${familiesCount}, Links: ${linksCount}, Snapshots: ${snapshotsCount}\n  Start API: npm run api:pmci`,
      );
    }

    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

