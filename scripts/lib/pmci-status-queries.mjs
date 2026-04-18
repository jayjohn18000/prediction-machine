/**
 * Shared SQL for npm run pmci:status and the daily digest Edge Function (via copy or future import).
 */
export const SQL_SMOKE_COUNTS = `
  SELECT
    (SELECT COUNT(*)::bigint FROM pmci.provider_markets) AS provider_markets,
    (SELECT COUNT(*)::bigint FROM pmci.provider_market_snapshots) AS snapshots,
    (SELECT COUNT(*)::bigint FROM pmci.market_families) AS families,
    (SELECT COUNT(*)::bigint FROM pmci.v_market_links_current) AS current_links;
`;

export const SQL_PENDING_PROPOSALS = `
  SELECT
    category,
    count(*)::int AS cnt
  FROM pmci.proposed_links
  WHERE decision IS NULL
  GROUP BY category
  ORDER BY cnt DESC;
`;

export const SQL_ACTIVE_LINKS_BY_CATEGORY = `
  SELECT
    pm.category,
    count(DISTINCT ml.id)::int AS active_link_rows
  FROM pmci.market_links ml
  JOIN pmci.provider_markets pm ON pm.id = ml.provider_market_id
  WHERE ml.status = 'active'
  GROUP BY pm.category
  ORDER BY active_link_rows DESC;
`;

export const SQL_OBSERVER_HEARTBEAT = `
  SELECT
    cycle_at,
    extract(epoch from (now() - cycle_at))::int AS lag_seconds,
    pairs_configured,
    pairs_attempted,
    pairs_succeeded
  FROM pmci.observer_heartbeats
  ORDER BY cycle_at DESC
  LIMIT 1;
`;

/**
 * @param {import("pg").Client} client
 */
export async function fetchPmciStatusBundle(client) {
  const [counts, pending, linksByCat, hb] = await Promise.all([
    client.query(SQL_SMOKE_COUNTS),
    client.query(SQL_PENDING_PROPOSALS),
    client.query(SQL_ACTIVE_LINKS_BY_CATEGORY),
    client.query(SQL_OBSERVER_HEARTBEAT),
  ]);
  return {
    smoke: counts.rows[0] || {},
    pending_proposals: pending.rows || [],
    active_links_by_category: linksByCat.rows || [],
    observer: hb.rows[0] || null,
  };
}
