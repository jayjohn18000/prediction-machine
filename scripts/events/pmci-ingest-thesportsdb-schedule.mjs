#!/usr/bin/env node
/**
 * Phase G: pull next events from TheSportsDB for configured leagues and upsert pmci.canonical_events.
 * Env: DATABASE_URL. Optional: THESPORTSDB_API_KEY, THESPORTSDB_API_BASE
 */
import { loadEnv } from "../../src/platform/env.mjs";
import pg from "pg";
import { createPmciClient } from "../../lib/pmci-ingestion.mjs";
import { THESPORTSDB_LEAGUE_IDS, fetchNextEventsForLeague, normalizeSportsDbEvent } from "../../lib/events/thesportsdb.mjs";
import { upsertCanonicalEventBatch } from "../../lib/events/upsert-schedule.mjs";

loadEnv();
const { Client } = pg;

const SUBCATEGORY_BY_LEAGUE = {
  [THESPORTSDB_LEAGUE_IDS.MLB]: "mlb",
  [THESPORTSDB_LEAGUE_IDS.NBA]: "nba",
  [THESPORTSDB_LEAGUE_IDS.NHL]: "nhl",
  [THESPORTSDB_LEAGUE_IDS.MLS]: "mls",
  [THESPORTSDB_LEAGUE_IDS.EPL]: "epl",
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }

  const client = createPmciClient() || new Client({ connectionString: databaseUrl });
  await client.connect();

  const leagues = [
    THESPORTSDB_LEAGUE_IDS.NBA,
    THESPORTSDB_LEAGUE_IDS.MLB,
    THESPORTSDB_LEAGUE_IDS.NHL,
  ];

  const horizonDays = Number(process.env.THESPORTSDB_HORIZON_DAYS ?? "14") || 14;
  let total = 0;
  for (const leagueId of leagues) {
    const raw = await fetchNextEventsForLeague({ leagueId, horizonDays });
    const sub = SUBCATEGORY_BY_LEAGUE[leagueId] || "sports";
    const rows = raw
      .map((ev) => normalizeSportsDbEvent(ev, { subcategory: sub }))
      .filter(Boolean);
    const n = await upsertCanonicalEventBatch(client, rows);
    console.log(`League ${leagueId} (${sub}): ${n}/${rows.length} canonical_events upserted`);
    total += n;
  }

  console.log("Done. Total upserted:", total);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
