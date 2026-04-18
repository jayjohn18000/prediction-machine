/**
 * Phase G: when two provider_markets from different providers map to the same
 * canonical_market (same event + market_template), create/update market_families + market_links.
 * Implemented incrementally after provider_event_map / provider_market_map are populated.
 */

/**
 * @param {import('pg').Client} _client
 * @returns {Promise<{ linked: number }>}
 */
export async function runAutoLinkPass(_client) {
  return { linked: 0 };
}
