#!/usr/bin/env node
/**
 * Phase G: upsert canonical_events from distinct active sports provider_markets rows.
 * Complements TheSportsDB schedule pulls — the public API often returns only one game per league per day
 * on eventsday.php, so Kalshi/Polymarket matchups would otherwise have no canonical event to attach to.
 *
 * Env: DATABASE_URL
 */
import { loadEnv } from "../../src/platform/env.mjs";
import pg from "pg";
import { createPmciClient } from "../../lib/pmci-ingestion.mjs";
import { upsertCanonicalEventBatch } from "../../lib/events/upsert-schedule.mjs";
import { sanitizeExtractedTeamSegment } from "../../lib/normalization/market-type-classifier.mjs";

loadEnv();
const { Client } = pg;

function slugPart(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Belt-and-suspenders: strip any colon-suffix market-type bucket the backfill missed,
 * then re-clean. Defensive — in healthy state the backfill has already done this.
 */
function cleanTeamName(s) {
  if (s == null) return "";
  return sanitizeExtractedTeamSegment(String(s).trim());
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }

  const client = createPmciClient() || new Client({ connectionString: databaseUrl });
  await client.connect();

  const { rows } = await client.query(`
    SELECT
      lower(trim(sport)) AS sport,
      game_date::text AS d,
      home_team AS home_team,
      away_team AS away_team,
      count(*)::int AS n
    FROM pmci.provider_markets
    WHERE category = 'sports'
      AND (status IS NULL OR status IN ('active', 'open'))
      AND game_date IS NOT NULL
      AND home_team IS NOT NULL AND trim(home_team) <> ''
      AND away_team IS NOT NULL AND trim(away_team) <> ''
      AND lower(trim(sport)) = ANY ($1::text[])
    GROUP BY lower(trim(sport)), game_date, home_team, away_team
  `, [["mlb", "nba", "nhl", "soccer", "mls", "epl"]]);

  /**
   * Phase G bugfix 2026-04-19: post-aggregate, sanitize team strings in JS then re-dedup on the
   * sanitized key. SQL-level max()/group-by would still collapse suffixed variants together but
   * would not drop the suffix from the kept row. Doing it here guarantees clean canonical events
   * even if the provider_markets backfill missed a pattern.
   */
  const deduped = new Map();
  for (const r of rows) {
    const sport = r.sport;
    const d = r.d;
    const home = cleanTeamName(r.home_team);
    const away = cleanTeamName(r.away_team);
    if (!home || !away) continue;
    const key = `${sport}::${d}::${away.toLowerCase()}::${home.toLowerCase()}`;
    const prev = deduped.get(key);
    if (prev) {
      prev.n += Number(r.n || 0);
      continue;
    }
    deduped.set(key, { sport, d, home_team: home, away_team: away, n: Number(r.n || 0) });
  }

  const normalized = [...deduped.values()].map((r) => {
    const sub = r.sport;
    const slug = `pmci-game-${sub}-${r.d}-${slugPart(r.away_team)}-${slugPart(r.home_team)}`;
    const title = `${r.away_team} @ ${r.home_team}`;
    return {
      slug,
      title,
      category: "sports",
      subcategory: sub,
      event_date: r.d,
      event_time: null,
      participants: [
        { name: r.away_team, role: "away" },
        { name: r.home_team, role: "home" },
      ],
      external_ref: null,
      external_source: "pmci_provider_seed",
      metadata: { source: "provider_markets_distinct", row_count: r.n },
    };
  });

  const n = await upsertCanonicalEventBatch(client, normalized);
  console.log(
    JSON.stringify({
      distinct_matchups: rows.length,
      upserted: n,
    }),
  );

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
