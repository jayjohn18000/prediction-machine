#!/usr/bin/env node
/**
 * Phase G closure: measure the canonical_market slot-state distribution used
 * in phase-g-bilateral-linking-postmortem.md.
 *
 * Output (JSON, stdout):
 *   {
 *     category: "sports" | "politics" | ...,
 *     total_slots,
 *     bilateral_ready,   // n_kalshi=1 AND n_poly=1
 *     overfilled,        // n_kalshi>1 OR n_poly>1
 *     kalshi_solo,       // n_kalshi=1, n_poly=0
 *     poly_solo,         // n_kalshi=0, n_poly=1
 *     empty,             // n_kalshi=0 AND n_poly=0
 *     already_linked,    // rows in pmci.market_links with both fam_id set, for comparison
 *     per_template: [...]
 *   }
 *
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

const KALSHI_PROVIDER_ID = 1; // pmci.providers: 1=kalshi, 2=polymarket (confirmed live)
const POLY_PROVIDER_ID = 2;

const categories = ["sports", "politics"];

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const out = {};

  for (const cat of categories) {
    const { rows } = await client.query(
      `
      WITH slot_counts AS (
        SELECT cm.id AS cm_id,
               cm.market_template,
               SUM(CASE WHEN pm.provider_id = $1 THEN 1 ELSE 0 END) AS n_kalshi,
               SUM(CASE WHEN pm.provider_id = $2 THEN 1 ELSE 0 END) AS n_poly
        FROM pmci.canonical_markets cm
        JOIN pmci.canonical_events ce ON ce.id = cm.canonical_event_id
        LEFT JOIN pmci.provider_market_map pmm
               ON pmm.canonical_market_id = cm.id
              AND pmm.removed_at IS NULL
              AND (pmm.status IS NULL OR pmm.status = 'active')
        LEFT JOIN pmci.provider_markets pm ON pm.id = pmm.provider_market_id
        WHERE ce.category = $3
        GROUP BY cm.id, cm.market_template
      )
      SELECT
        COUNT(*)::int                                              AS total_slots,
        SUM(CASE WHEN n_kalshi = 1 AND n_poly = 1 THEN 1 ELSE 0 END)::int AS bilateral_ready,
        SUM(CASE WHEN n_kalshi > 1 OR  n_poly > 1 THEN 1 ELSE 0 END)::int AS overfilled,
        SUM(CASE WHEN n_kalshi = 1 AND n_poly = 0 THEN 1 ELSE 0 END)::int AS kalshi_solo,
        SUM(CASE WHEN n_kalshi = 0 AND n_poly = 1 THEN 1 ELSE 0 END)::int AS poly_solo,
        SUM(CASE WHEN n_kalshi = 0 AND n_poly = 0 THEN 1 ELSE 0 END)::int AS empty
      FROM slot_counts
      `,
      [KALSHI_PROVIDER_ID, POLY_PROVIDER_ID, cat],
    );
    out[cat] = rows[0];

    const { rows: tmpl } = await client.query(
      `
      WITH slot_counts AS (
        SELECT cm.market_template,
               SUM(CASE WHEN pm.provider_id = $1 THEN 1 ELSE 0 END) AS n_kalshi,
               SUM(CASE WHEN pm.provider_id = $2 THEN 1 ELSE 0 END) AS n_poly
        FROM pmci.canonical_markets cm
        JOIN pmci.canonical_events ce ON ce.id = cm.canonical_event_id
        LEFT JOIN pmci.provider_market_map pmm
               ON pmm.canonical_market_id = cm.id
              AND pmm.removed_at IS NULL
              AND (pmm.status IS NULL OR pmm.status = 'active')
        LEFT JOIN pmci.provider_markets pm ON pm.id = pmm.provider_market_id
        WHERE ce.category = $3
        GROUP BY cm.id, cm.market_template
      )
      SELECT market_template,
             COUNT(*)::int AS total,
             SUM(CASE WHEN n_kalshi = 1 AND n_poly = 1 THEN 1 ELSE 0 END)::int AS bilateral_ready,
             SUM(CASE WHEN n_kalshi > 1 OR  n_poly > 1 THEN 1 ELSE 0 END)::int AS overfilled,
             SUM(CASE WHEN n_kalshi = 1 AND n_poly = 0 THEN 1 ELSE 0 END)::int AS kalshi_solo,
             SUM(CASE WHEN n_kalshi = 0 AND n_poly = 1 THEN 1 ELSE 0 END)::int AS poly_solo
      FROM slot_counts
      GROUP BY market_template
      ORDER BY total DESC
      `,
      [KALSHI_PROVIDER_ID, POLY_PROVIDER_ID, cat],
    );
    out[`${cat}_per_template`] = tmpl;
  }

  // Live pmci.market_links: per-provider-leg edges grouped by family_id. A bilateral
  // family has at least one Kalshi leg and at least one Polymarket leg both active.
  const { rows: links } = await client.query(
    `
    WITH leg AS (
      SELECT ml.family_id, ml.provider_id, ce.category, ml.link_version
      FROM pmci.market_links ml
      JOIN pmci.provider_markets pm ON pm.id = ml.provider_market_id
      JOIN pmci.provider_market_map pmm
             ON pmm.provider_market_id = pm.id
            AND pmm.removed_at IS NULL
            AND (pmm.status IS NULL OR pmm.status = 'active')
      JOIN pmci.canonical_markets cm ON cm.id = pmm.canonical_market_id
      JOIN pmci.canonical_events ce ON ce.id = cm.canonical_event_id
      WHERE ml.status = 'active' AND ml.removed_at IS NULL
    ),
    fam AS (
      SELECT family_id, category,
             BOOL_OR(provider_id = $1) AS has_kalshi,
             BOOL_OR(provider_id = $2) AS has_poly,
             COUNT(*) AS leg_count,
             MAX(link_version) AS max_link_version
      FROM leg
      WHERE category = ANY($3)
      GROUP BY family_id, category
    )
    SELECT category,
           COUNT(*)::int                                    AS families_total,
           SUM(CASE WHEN has_kalshi AND has_poly THEN 1 ELSE 0 END)::int AS bilateral_families,
           SUM(CASE WHEN has_kalshi AND NOT has_poly THEN 1 ELSE 0 END)::int AS kalshi_only_families,
           SUM(CASE WHEN has_poly AND NOT has_kalshi THEN 1 ELSE 0 END)::int AS poly_only_families,
           SUM(leg_count)::int                              AS total_legs,
           MAX(max_link_version)::int                       AS max_link_version
    FROM fam
    GROUP BY category
    `,
    [KALSHI_PROVIDER_ID, POLY_PROVIDER_ID, categories],
  );
  out.market_links_families = Object.fromEntries(
    links.map((r) => [r.category, r]),
  );

  // Soccer-draw specific: slots whose market_template='sports-moneyline' with draw-family titles on both sides.
  const { rows: draw } = await client.query(
    `
    WITH s AS (
      SELECT cm.id AS cm_id,
             SUM(CASE WHEN pm.provider_id = $1 AND pm.title ~* 'draw' THEN 1 ELSE 0 END) AS n_k_draw,
             SUM(CASE WHEN pm.provider_id = $2 AND pm.title ~* 'draw' THEN 1 ELSE 0 END) AS n_p_draw,
             SUM(CASE WHEN pm.provider_id = $1 THEN 1 ELSE 0 END) AS n_kalshi,
             SUM(CASE WHEN pm.provider_id = $2 THEN 1 ELSE 0 END) AS n_poly
      FROM pmci.canonical_markets cm
      JOIN pmci.canonical_events ce ON ce.id = cm.canonical_event_id
      LEFT JOIN pmci.provider_market_map pmm
             ON pmm.canonical_market_id = cm.id
            AND pmm.removed_at IS NULL
            AND (pmm.status IS NULL OR pmm.status = 'active')
      LEFT JOIN pmci.provider_markets pm ON pm.id = pmm.provider_market_id
      WHERE ce.category = 'sports'
      GROUP BY cm.id
    )
    SELECT
      SUM(CASE WHEN (n_k_draw > 0 OR n_p_draw > 0) THEN 1 ELSE 0 END)::int AS slots_with_any_draw_leg,
      SUM(CASE WHEN n_k_draw > 0 AND n_p_draw > 0 THEN 1 ELSE 0 END)::int AS slots_with_both_provider_draw_legs,
      SUM(CASE WHEN n_k_draw > 0 AND n_p_draw > 0 AND n_kalshi = 1 AND n_poly = 1 THEN 1 ELSE 0 END)::int AS draw_bilateral_ready
    FROM s
    `,
    [KALSHI_PROVIDER_ID, POLY_PROVIDER_ID],
  );
  out.sports_draw_detail = draw[0];

  console.log(JSON.stringify(out, null, 2));
} finally {
  await client.end();
}
