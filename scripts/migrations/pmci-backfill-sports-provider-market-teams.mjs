#!/usr/bin/env node
/**
 * Re-extract home_team / away_team for sports provider_markets using Phase G suffix strip + vs/at split.
 * Env: DATABASE_URL. Optional: DRY_RUN=1, BATCH=500
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";
import { extractSportsMatchupTeamsFromTitle } from "../../lib/normalization/market-type-classifier.mjs";
import { looksLikeMatchupMarket } from "../../lib/matching/sports-helpers.mjs";

loadEnv();
const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(1);
}
const dry = process.env.DRY_RUN === "1";
const batchSize = Math.max(50, Number(process.env.BATCH ?? 500) || 500);

const client = new pg.Client({ connectionString: url });
await client.connect();

function sqlPollutedHomeTeam(s) {
  if (s == null) return false;
  const t = String(s);
  return t.includes("?") || /\bruns\b/i.test(t) || /\bwinner\b/i.test(t);
}

function sqlPollutedAwayTeam(s) {
  return sqlPollutedHomeTeam(s);
}

try {
  const { rows: countRow } = await client.query(`
    SELECT count(*)::int AS n
    FROM pmci.provider_markets
    WHERE category = 'sports' AND status = 'active'
  `);
  const total = countRow[0]?.n ?? 0;
  console.log(JSON.stringify({ active_sports_markets: total, dry_run: dry, batch: batchSize }));

  let updated = 0;
  let cleared = 0;
  let examined = 0;
  let lastId = 0;

  while (true) {
    const { rows } = await client.query(
      `
      SELECT id, title, home_team, away_team
      FROM pmci.provider_markets
      WHERE category = 'sports' AND status = 'active' AND id > $1
      ORDER BY id ASC
      LIMIT $2
    `,
      [lastId, batchSize],
    );
    if (!rows?.length) break;

    for (const row of rows) {
      examined++;
      lastId = Number(row.id);
      const title = String(row.title || "");
      const prevH = row.home_team != null ? String(row.home_team) : null;
      const prevA = row.away_team != null ? String(row.away_team) : null;

      if (!looksLikeMatchupMarket({ title })) {
        const bad =
          sqlPollutedHomeTeam(prevH) ||
          sqlPollutedAwayTeam(prevA) ||
          /\bwill\b/i.test(String(prevH || "")) ||
          /\bwill\b/i.test(String(prevA || ""));
        if (bad) {
          if (dry) {
            cleared++;
            continue;
          }
          await client.query(
            `UPDATE pmci.provider_markets SET home_team = NULL, away_team = NULL WHERE id = $1::bigint`,
            [row.id],
          );
          cleared++;
        }
        continue;
      }

      const { homeTeam, awayTeam } = extractSportsMatchupTeamsFromTitle(title);
      if (homeTeam == null && awayTeam == null) continue;

      if (prevH === homeTeam && prevA === awayTeam) continue;

      if (dry) {
        updated++;
        continue;
      }

      await client.query(
        `UPDATE pmci.provider_markets
         SET home_team = $2, away_team = $3
         WHERE id = $1::bigint`,
        [row.id, homeTeam, awayTeam],
      );
      updated++;
    }
  }

  const { rows: bad } = await client.query(`
    SELECT count(*)::int AS n
    FROM pmci.provider_markets
    WHERE status = 'active' AND category = 'sports'
      AND (
        home_team LIKE '%?%' OR home_team LIKE '%runs%' OR home_team ILIKE '%winner%'
      )
  `);

  console.log(
    JSON.stringify({
      examined_rows: examined,
      rows_updated_teams: updated,
      rows_cleared_non_matchup: cleared,
      polluted_home_team_remaining: bad[0]?.n ?? null,
      dry_run: dry,
    }),
  );
} finally {
  await client.end();
}
