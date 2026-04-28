/**
 * Live snapshot of PMCI freshness: MAX(observed_at) per provider via join to
 * provider_market_snapshots (no denormalized cache), approximate large-table counts,
 * exact small-table counts, and MAX(cycle_at) from observer_heartbeats.
 *
 * Approximate counts (pg_class.reltuples) match prior behavior; exact counts remain
 * for market_families and v_market_links_current.
 */

/** Exported for tests — bound snapshots so MAX(observed_at) cannot scan entire history (~4M+ rows). */
export const LIVE_FRESHNESS_SELECT = `
  WITH snap_by_provider AS (
    SELECT p.code,
           MAX(s.observed_at) AS max_observed_at
    FROM pmci.providers p
    LEFT JOIN pmci.provider_markets pm ON pm.provider_id = p.id
    LEFT JOIN pmci.provider_market_snapshots s
      ON s.provider_market_id = pm.id
     AND s.observed_at > now() - interval '15 minutes'
    GROUP BY p.code
  ),
  hb AS (
    SELECT MAX(cycle_at) AS observer_last_run
    FROM pmci.observer_heartbeats
  ),
  approx_counts AS (
    SELECT
      (SELECT coalesce(reltuples::bigint, 0) FROM pg_class
        WHERE oid = 'pmci.provider_markets'::regclass) AS provider_markets_count,
      (SELECT coalesce(reltuples::bigint, 0) FROM pg_class
        WHERE oid = 'pmci.provider_market_snapshots'::regclass) AS snapshot_count
  ),
  exact_counts AS (
    SELECT
      (SELECT count(*)::int FROM pmci.market_families) AS families_count,
      (SELECT count(*)::int FROM pmci.v_market_links_current) AS current_links_count
  ),
  agg AS (
    SELECT
      MAX(sbp.max_observed_at) AS latest_snapshot_at,
      MAX(sbp.max_observed_at) FILTER (WHERE sbp.code = 'kalshi') AS latest_kalshi_snapshot_at,
      MAX(sbp.max_observed_at) FILTER (WHERE sbp.code = 'polymarket') AS latest_polymarket_snapshot_at
    FROM snap_by_provider sbp
  )
  SELECT
    agg.latest_snapshot_at,
    agg.latest_kalshi_snapshot_at,
    agg.latest_polymarket_snapshot_at,
    ac.provider_markets_count,
    ac.snapshot_count,
    ec.families_count,
    ec.current_links_count,
    hb.observer_last_run
  FROM agg
  CROSS JOIN approx_counts ac
  CROSS JOIN exact_counts ec
  CROSS JOIN hb
`;

export async function computeLiveFreshnessSnapshot(deps) {
  const query = deps?.query;
  if (!query) return null;
  const { rows } = await query(LIVE_FRESHNESS_SELECT);
  return rows[0] ?? null;
}
