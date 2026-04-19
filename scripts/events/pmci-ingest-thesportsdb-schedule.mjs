#!/usr/bin/env node
/**
 * Phase G: pull next events from TheSportsDB for configured leagues and upsert pmci.canonical_events.
 * Merges a rolling UTC date window with distinct game_date values from active sports markets so
 * eventsday.php covers the full schedule (eventsnextleague.php alone is capped ~15 rows/league).
 *
 * Env: DATABASE_URL. Optional: THESPORTSDB_API_KEY, THESPORTSDB_API_BASE, THESPORTSDB_HORIZON_DAYS
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
  [THESPORTSDB_LEAGUE_IDS.LA_LIGA]: "soccer",
  [THESPORTSDB_LEAGUE_IDS.BUNDESLIGA]: "soccer",
  [THESPORTSDB_LEAGUE_IDS.SERIE_A]: "soccer",
  [THESPORTSDB_LEAGUE_IDS.LIGUE_1]: "soccer",
  [THESPORTSDB_LEAGUE_IDS.UCL]: "soccer",
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
    THESPORTSDB_LEAGUE_IDS.MLS,
    THESPORTSDB_LEAGUE_IDS.EPL,
  ];

  const horizonDays = Number(process.env.THESPORTSDB_HORIZON_DAYS ?? "14") || 14;

  const { rows: dateRows } = await client.query(`
    SELECT DISTINCT game_date::text AS d
    FROM pmci.provider_markets
    WHERE status = 'active'
      AND sport = ANY($1::text[])
      AND game_date IS NOT NULL
      AND game_date >= (current_date - 2)
      AND game_date <= (current_date + 60)
  `, [["mlb", "nba", "nhl", "soccer"]]);

  const datesFromMarkets = dateRows.map((r) => r.d).filter(Boolean);
  console.log(
    JSON.stringify({
      horizon_days: horizonDays,
      extra_dates_from_provider_markets: datesFromMarkets.length,
    }),
  );

  let total = 0;
  for (const leagueId of leagues) {
    const raw = await fetchNextEventsForLeague({
      leagueId,
      horizonDays,
      dates: datesFromMarkets,
      mergeRollingDates: true,
    });
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
