#!/usr/bin/env node
/**
 * Backfill event_date + participants on phase7_migration canonical_events from linked provider_markets.
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

function participantsFromRows(rows) {
  for (const r of rows) {
    const h = String(r.home_team || "").trim();
    const a = String(r.away_team || "").trim();
    if (h && a) {
      return JSON.stringify([
        { name: a, role: "away" },
        { name: h, role: "home" },
      ]);
    }
  }
  return null;
}

try {
  const { rows: ces } = await client.query(
    `SELECT id FROM pmci.canonical_events WHERE source_annotation = 'phase7_migration'`,
  );
  let updated = 0;
  for (const ce of ces || []) {
    const { rows: pmRows } = await client.query(
      `SELECT pm.game_date, pm.home_team, pm.away_team, pm.sport
       FROM pmci.canonical_markets cm
       JOIN pmci.provider_market_map pmm ON pmm.canonical_market_id = cm.id
         AND (pmm.removed_at IS NULL) AND (pmm.status IS NULL OR pmm.status = 'active')
       JOIN pmci.provider_markets pm ON pm.id = pmm.provider_market_id
       WHERE cm.canonical_event_id = $1::uuid`,
      [ce.id],
    );
    if (!pmRows?.length) continue;

    const dates = pmRows
      .map((r) => r.game_date)
      .filter(Boolean)
      .map((d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)))
      .sort();
    const eventDate = dates.length ? dates[0] : null;
    const partsJson = participantsFromRows(pmRows);

    const sportCounts = new Map();
    for (const r of pmRows) {
      const s = String(r.sport || "")
        .trim()
        .toLowerCase();
      if (!s || s === "unknown") continue;
      sportCounts.set(s, (sportCounts.get(s) || 0) + 1);
    }
    let dominantSport = null;
    let bestN = 0;
    for (const [s, n] of sportCounts) {
      if (n > bestN) {
        bestN = n;
        dominantSport = s;
      }
    }

    if (!eventDate && !partsJson && !dominantSport) continue;

    if (dry) {
      console.log("would update", ce.id, { eventDate, hasParts: !!partsJson, subcategory: dominantSport });
      updated++;
      continue;
    }

    await client.query(
      `UPDATE pmci.canonical_events
       SET event_date = COALESCE($2::date, event_date),
           participants = COALESCE($3::jsonb, participants),
           subcategory = COALESCE($4::text, subcategory),
           updated_at = now()
       WHERE id = $1::uuid`,
      [ce.id, eventDate, partsJson, dominantSport],
    );
    updated++;
  }
  console.log(JSON.stringify({ backfilled_phase7_events: updated, dry_run: dry }));
} finally {
  await client.end();
}
