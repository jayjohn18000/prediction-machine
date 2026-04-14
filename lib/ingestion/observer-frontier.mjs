/**
 * DB-driven observation frontier: active cross-venue links with cap + priority.
 * Shape matches observer pair objects built in observer.mjs.
 */
import {
  getObserverRelationshipTypes,
  parseObserverCategoryAllowlist,
  getObserverMaxPairsPerCycle,
} from "../matching/compatibility.mjs";

const SQL_FRONTIER = `
  SELECT
    mf.label AS family_label,
    k_pm.provider_market_ref AS kalshi_ticker,
    p_pm.provider_market_ref AS poly_ref,
    p_pm.event_ref AS poly_slug,
    k_pm.title AS event_name
  FROM pmci.market_links k_link
  JOIN pmci.market_families mf ON mf.id = k_link.family_id
  JOIN pmci.market_links p_link
    ON k_link.family_id = p_link.family_id
    AND k_link.provider_market_id != p_link.provider_market_id
  JOIN pmci.providers k_prov ON k_link.provider_id = k_prov.id AND k_prov.code = 'kalshi'
  JOIN pmci.providers p_prov ON p_link.provider_id = p_prov.id AND p_prov.code = 'polymarket'
  JOIN pmci.provider_markets k_pm ON k_link.provider_market_id = k_pm.id
  JOIN pmci.provider_markets p_pm ON p_link.provider_market_id = p_pm.id
  WHERE k_link.status = 'active'
    AND p_link.status = 'active'
    AND k_link.relationship_type::text = ANY($1::text[])
    AND p_link.relationship_type::text = ANY($1::text[])
    AND ($2::text[] IS NULL OR (
      lower(COALESCE(k_pm.category, '')) = ANY($2::text[])
      AND lower(COALESCE(p_pm.category, '')) = ANY($2::text[])
    ))
  ORDER BY GREATEST(k_pm.last_seen_at, p_pm.last_seen_at) DESC NULLS LAST, k_pm.id DESC
  LIMIT $3
`;

function mapRowToPair(r) {
  const polyRef = r.poly_ref || "";
  const hashIdx = polyRef.indexOf("#");
  const polymarketSlug = r.poly_slug || (hashIdx > 0 ? polyRef.slice(0, hashIdx) : polyRef);
  const polymarketOutcomeName = hashIdx >= 0 ? polyRef.slice(hashIdx + 1) : "Yes";
  return {
    eventName: r.event_name || r.family_label || r.kalshi_ticker,
    kalshiTicker: r.kalshi_ticker,
    polymarketSlug,
    polymarketOutcomeName,
    _source: "db",
  };
}

/**
 * @param {import('pg').Client} pmciClient
 * @param {object} [opts]
 * @param {number} [opts.maxPairs]
 * @param {string[]} [opts.relationshipTypes]
 * @param {string[]|null} [opts.categoryAllowlist]
 */
export async function discoverFrontierPairs(pmciClient, opts = {}) {
  if (!pmciClient) return [];
  const maxPairs = opts.maxPairs ?? getObserverMaxPairsPerCycle();
  const relationshipTypes =
    opts.relationshipTypes ?? getObserverRelationshipTypes();
  const categoryAllowlist =
    opts.categoryAllowlist !== undefined
      ? opts.categoryAllowlist
      : parseObserverCategoryAllowlist();

  const params = [relationshipTypes, categoryAllowlist, maxPairs];

  try {
    const res = await pmciClient.query(SQL_FRONTIER, params);
    const pairs = (res.rows || []).map(mapRowToPair);
    console.log(
      `[observer] frontier query: ${pairs.length} pairs (cap=${maxPairs}, relationships=${relationshipTypes.join(",")}${categoryAllowlist?.length ? `, categories=${categoryAllowlist.join(",")}` : ""})`,
    );
    return pairs;
  } catch (err) {
    console.warn("[observer] frontier query failed:", err.message);
    return [];
  }
}
