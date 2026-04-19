#!/usr/bin/env node
/**
 * Delete pre–Phase-G noise: stub market_families (no market_links) on unknown CEs, then
 * canonical_events that are still unreferenced (no pem, no pmm path, no remaining mf).
 *
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

/** Unknown CE with no pem and no provider_market_map attachment */
const orphanCePredicate = `
  ce.source_annotation = 'unknown'
  AND NOT EXISTS (SELECT 1 FROM pmci.provider_event_map pem WHERE pem.canonical_event_id = ce.id)
  AND NOT EXISTS (
    SELECT 1
    FROM pmci.canonical_markets cm
    INNER JOIN pmci.provider_market_map pmm ON pmm.canonical_market_id = cm.id
    WHERE cm.canonical_event_id = ce.id
  )
`;

try {
  const stubMf = await client.query(`
    SELECT mf.id
    FROM pmci.market_families mf
    INNER JOIN pmci.canonical_events ce ON ce.id = mf.canonical_event_id
    WHERE ${orphanCePredicate}
      AND NOT EXISTS (SELECT 1 FROM pmci.market_links ml WHERE ml.family_id = mf.id)
  `);
  const stubN = stubMf.rows?.length ?? 0;
  console.log(`Stub market_families (unknown CE, no links): ${stubN}`);

  if (dry) {
    console.log(
      JSON.stringify({
        deleted_stub_market_families: stubN,
        deleted_canonical_events: "pending (re-run without DRY_RUN)",
        dry_run: true,
      }),
    );
    process.exit(0);
  }

  let deletedMf = 0;
  if (stubN > 0) {
    const delMf = await client.query(`
      DELETE FROM pmci.market_families mf
      USING pmci.canonical_events ce
      WHERE ce.id = mf.canonical_event_id
        AND ${orphanCePredicate}
        AND NOT EXISTS (SELECT 1 FROM pmci.market_links ml WHERE ml.family_id = mf.id)
      RETURNING mf.id
    `);
    deletedMf = delMf.rowCount ?? 0;
  }

  const del = await client.query(`
    DELETE FROM pmci.canonical_events ce
    WHERE ${orphanCePredicate}
      AND NOT EXISTS (SELECT 1 FROM pmci.market_families mf WHERE mf.canonical_event_id = ce.id)
    RETURNING id
  `);

  console.log(
    JSON.stringify({
      deleted_stub_market_families: deletedMf,
      deleted_canonical_events: del.rowCount ?? 0,
      dry_run: false,
    }),
  );
} finally {
  await client.end();
}
