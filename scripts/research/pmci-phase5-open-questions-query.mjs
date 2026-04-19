#!/usr/bin/env node
/**
 * Phase 5: answer postmortem open questions from live DB (read-only).
 * Env: DATABASE_URL
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();
const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const sportsCurrent = await client.query(`
    SELECT
      count(*)::int AS link_rows,
      count(DISTINCT v.family_id)::int AS families_touched
    FROM pmci.v_market_links_current v
    JOIN pmci.market_families mf ON mf.id = v.family_id
    JOIN pmci.canonical_events ce ON ce.id = mf.canonical_event_id
    WHERE ce.category = 'sports'
  `);

  const sportsEquivPairs = await client.query(`
    WITH cur AS (
      SELECT * FROM pmci.v_market_links_current v
      JOIN pmci.market_families mf ON mf.id = v.family_id
      JOIN pmci.canonical_events ce ON ce.id = mf.canonical_event_id
      WHERE ce.category = 'sports'
        AND v.relationship_type = 'equivalent'
    ),
    fam AS (
      SELECT family_id, count(DISTINCT provider_id)::int AS n_prov
      FROM cur
      GROUP BY family_id
    )
    SELECT
      count(*)::int AS equivalent_sports_families,
      count(*) FILTER (WHERE n_prov = 2)::int AS families_with_both_providers
    FROM fam
  `);

  const versionDist = await client.query(`
    SELECT v.link_version, count(*)::int AS n
    FROM pmci.v_market_links_current v
    JOIN pmci.market_families mf ON mf.id = v.family_id
    JOIN pmci.canonical_events ce ON ce.id = mf.canonical_event_id
    WHERE ce.category = 'sports'
    GROUP BY v.link_version
    ORDER BY v.link_version
  `);

  const reasonsSample = await client.query(`
    SELECT v.link_version, v.reasons->>'source' AS src, count(*)::int AS n
    FROM pmci.v_market_links_current v
    JOIN pmci.market_families mf ON mf.id = v.family_id
    JOIN pmci.canonical_events ce ON ce.id = mf.canonical_event_id
    WHERE ce.category = 'sports'
    GROUP BY v.link_version, v.reasons->>'source'
    ORDER BY v.link_version, n DESC
  `);

  const linkerRuns = await client.query(`
    SELECT version, description, created_at
    FROM pmci.linker_runs
    ORDER BY version DESC
    LIMIT 15
  `);

  const bilateralSlots = await client.query(`
    WITH legs AS (
      SELECT pmm.canonical_market_id, pr.code AS provider_code, count(*)::int AS n
      FROM pmci.provider_market_map pmm
      JOIN pmci.providers pr ON pr.id = pmm.provider_id
      JOIN pmci.canonical_markets cm ON cm.id = pmm.canonical_market_id
      JOIN pmci.canonical_events ce ON ce.id = cm.canonical_event_id
      WHERE pmm.removed_at IS NULL
        AND (pmm.status IS NULL OR pmm.status = 'active')
        AND ce.category = 'sports'
      GROUP BY pmm.canonical_market_id, pr.code
    ),
    slot AS (
      SELECT canonical_market_id,
        coalesce(max(n) FILTER (WHERE provider_code = 'kalshi'), 0) AS n_k,
        coalesce(max(n) FILTER (WHERE provider_code = 'polymarket'), 0) AS n_p
      FROM legs
      GROUP BY canonical_market_id
    )
    SELECT count(*)::int AS bilateral_ready_slots
    FROM slot
    WHERE n_k = 1 AND n_p = 1
  `);

  const out = {
    sports_v_market_links_current: sportsCurrent.rows[0],
    sports_equivalent_families: sportsEquivPairs.rows[0],
    sports_link_version_distribution: versionDist.rows,
    sports_links_by_version_and_reason_source: reasonsSample.rows,
    sports_bilateral_ready_slots_1k1p: bilateralSlots.rows[0],
    linker_runs_latest: linkerRuns.rows,
  };
  console.log(JSON.stringify(out, null, 2));
} finally {
  await client.end();
}
