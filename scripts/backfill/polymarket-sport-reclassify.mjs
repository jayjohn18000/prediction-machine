#!/usr/bin/env node
/**
 * Phase Linker H2H Expansion — Step 4 (Lever A support)
 *
 * Re-run the upgraded `resolvePolymarketSport` classifier over every active
 * Polymarket sports provider_markets row and compare the projected sport
 * classification against the current `sport` column.
 *
 * - `--dry-run` (default): prints before/after sport distribution and how many
 *   rows WOULD change. NO database writes.
 * - `--apply`: transactionally updates `pmci.provider_markets.sport` in
 *   batches of 1,000 rows. Idempotent — a second run changes nothing.
 *
 * Scope: `provider_id = (provider where code='polymarket')`, `status='active'`,
 * `category='sports'`. Rows whose classifier output equals the current `sport`
 * are not touched.
 *
 * Invariants respected:
 *   - No .env writes (env is read-only).
 *   - No bulk inactivation (we only rewrite `sport` on active rows).
 *   - The caller MUST NOT run `--apply` without explicit approval (see
 *     docs/plans/phase-linker-h2h-expansion-plan.md Step 4).
 */

import { loadEnv } from "../../src/platform/env.mjs";
import pg from "pg";
import {
  resolvePolymarketSport,
  POLYMARKET_SPORT_CLASSIFIER_VERSION,
} from "../../lib/ingestion/services/sport-inference.mjs";

loadEnv();
const { Client } = pg;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DRY_RUN = !APPLY || args.includes("--dry-run");
const BATCH_SIZE = 1000;
const SCOPE_FILTER = args.find((a) => a.startsWith("--filter="));
const EXTRA_WHERE = SCOPE_FILTER ? SCOPE_FILTER.slice("--filter=".length) : null;

function bucketCounts(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const v = String(r[key] ?? "null").toLowerCase();
    out.set(v, (out.get(v) ?? 0) + 1);
  }
  return new Map([...out.entries()].sort((a, b) => b[1] - a[1]));
}

function printTable(title, before, after) {
  console.log(`\n=== ${title} ===`);
  const keys = new Set([...before.keys(), ...after.keys()]);
  const rows = [...keys].map((k) => ({
    sport: k,
    before: before.get(k) ?? 0,
    after: after.get(k) ?? 0,
    delta: (after.get(k) ?? 0) - (before.get(k) ?? 0),
  }));
  rows.sort((a, b) => Math.max(b.after, b.before) - Math.max(a.after, a.before));
  const pad = (s, n) => String(s).padEnd(n, " ");
  console.log(`${pad("sport", 16)}${pad("before", 10)}${pad("after", 10)}${pad("delta", 10)}`);
  for (const r of rows) {
    console.log(
      `${pad(r.sport, 16)}${pad(r.before, 10)}${pad(r.after, 10)}${pad((r.delta >= 0 ? "+" : "") + r.delta, 10)}`,
    );
  }
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const extraWhereSql = EXTRA_WHERE ? ` AND ${EXTRA_WHERE}` : "";
    const { rows } = await client.query(`
      SELECT pm.id,
             pm.title,
             pm.event_ref,
             pm.sport AS current_sport,
             pm.home_team,
             pm.away_team,
             pm.metadata->>'tag_id'   AS tag_id,
             pm.metadata->>'tag_slug' AS tag_slug,
             pm.metadata->>'slug'     AS slug
      FROM pmci.provider_markets pm
      JOIN pmci.providers p ON pm.provider_id = p.id
      WHERE p.code = 'polymarket'
        AND pm.category = 'sports'
        AND coalesce(pm.status,'') IN ('active','open')
        ${extraWhereSql}
    `);
    console.log(
      `[reclassify] classifier=${POLYMARKET_SPORT_CLASSIFIER_VERSION} inspected=${rows.length} ` +
        `mode=${APPLY && !DRY_RUN ? "APPLY" : "DRY-RUN"}`,
    );

    const projected = rows.map((r) => {
      const tagBits = [r.tag_slug, r.tag_id].filter(Boolean).map(String);
      const newSport = resolvePolymarketSport(tagBits, r.title, {
        tag_id: r.tag_id,
        event_ref: r.event_ref,
        slug: r.slug,
      });
      return { ...r, new_sport: newSport };
    });

    const before = bucketCounts(projected, "current_sport");
    const after = bucketCounts(projected, "new_sport");
    printTable("All active Polymarket sports rows", before, after);

    const h2h = projected.filter((p) => p.home_team && p.away_team);
    const h2hBefore = bucketCounts(h2h, "current_sport");
    const h2hAfter = bucketCounts(h2h, "new_sport");
    printTable(
      "H2H-shaped rows (home_team & away_team present)",
      h2hBefore,
      h2hAfter,
    );

    const changed = projected.filter(
      (p) => String(p.current_sport ?? "unknown").toLowerCase() !== String(p.new_sport).toLowerCase(),
    );
    const h2hChanged = changed.filter((p) => p.home_team && p.away_team);
    const unknownBeforeH2h = h2h.filter(
      (p) => String(p.current_sport ?? "unknown").toLowerCase() === "unknown",
    ).length;
    const unknownAfterH2h = h2h.filter(
      (p) => String(p.new_sport).toLowerCase() === "unknown",
    ).length;

    console.log(
      `\n[reclassify] changed=${changed.length} h2h_changed=${h2hChanged.length}`,
    );
    console.log(
      `[reclassify] h2h_unknown: before=${unknownBeforeH2h} after=${unknownAfterH2h} ` +
        `delta=${unknownAfterH2h - unknownBeforeH2h}`,
    );

    const perSport = new Map();
    for (const c of h2hChanged) {
      const k = c.new_sport;
      perSport.set(k, (perSport.get(k) ?? 0) + 1);
    }
    console.log("\n[reclassify] H2H-row reclassifications by target sport:");
    for (const [sport, n] of [...perSport.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${sport.padEnd(16)}${n}`);
    }

    if (!APPLY || DRY_RUN) {
      console.log(
        "\n[reclassify] DRY-RUN complete — no rows were modified. " +
          "Re-run with --apply (and only with explicit owner approval) to commit.",
      );
      return;
    }

    console.log(`\n[reclassify] APPLY mode: writing ${changed.length} rows in bulk UNNEST batches of ${BATCH_SIZE}`);
    let written = 0;
    for (let i = 0; i < changed.length; i += BATCH_SIZE) {
      const batch = changed.slice(i, i + BATCH_SIZE);
      const ids = batch.map((r) => String(r.id));
      const sports = batch.map((r) => String(r.new_sport));
      await client.query("BEGIN");
      try {
        const result = await client.query(
          `
          UPDATE pmci.provider_markets pm
          SET sport = src.new_sport
          FROM (
            SELECT id::bigint AS id, new_sport::text AS new_sport
            FROM UNNEST($1::bigint[], $2::text[]) AS t(id, new_sport)
          ) src
          WHERE pm.id = src.id AND COALESCE(pm.sport, '') <> src.new_sport
          `,
          [ids, sports],
        );
        await client.query("COMMIT");
        written += result.rowCount || 0;
        console.log(`[reclassify] committed batch rows=${result.rowCount} total=${written}/${changed.length}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    console.log(`[reclassify] done. rows updated: ${written}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[reclassify] FATAL:", err);
  process.exit(1);
});
