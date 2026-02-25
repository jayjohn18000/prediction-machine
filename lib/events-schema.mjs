/**
 * Canonical schema for prediction-market events, markets, and outcomes.
 * This is intentionally provider-agnostic; concrete adapters (Kalshi, Polymarket, etc.)
 * should map their native payloads into these shapes.
 */

/**
 * @typedef {'kalshi' | 'polymarket'} ProviderId
 */

/**
 * Provider-specific reference for an event.
 *
 * @typedef {Object} ProviderEventRef
 * @property {ProviderId} provider
 * @property {string} eventId
 * @property {string} [eventTicker]   - e.g. Kalshi event_ticker
 * @property {string} [seriesTicker]  - e.g. Kalshi series_ticker
 * @property {string} [slug]          - e.g. Polymarket event slug
 */

/**
 * Provider-specific reference for a market.
 *
 * @typedef {Object} ProviderMarketRef
 * @property {ProviderId} provider
 * @property {string} marketId        - e.g. Kalshi market ticker or Polymarket conditionId
 * @property {string} [ticker]        - For providers that distinguish marketId vs ticker
 * @property {string} [slug]          - e.g. Polymarket market slug
 * @property {string} [eventId]       - Provider-native event ID this market belongs to
 */

/**
 * Provider-specific reference for an outcome / contract.
 *
 * @typedef {Object} ProviderOutcomeRef
 * @property {ProviderId} provider
 * @property {string} outcomeId       - Provider-native outcome identifier
 * @property {string} [tokenId]       - e.g. Polymarket CLOB token id
 * @property {string} [side]          - e.g. "YES" / "NO"
 */

/**
 * Canonical representation of a single tradeable outcome (e.g. YES on a given candidate).
 *
 * @typedef {Object} CanonicalOutcome
 * @property {string} id              - Canonical outcome ID, globally unique within a market
 * @property {string} marketId        - CanonicalMarket.id this belongs to
 * @property {string} label           - Human-readable label ("Gavin Newsom", "YES", "NO")
 * @property {('yes'|'no'|'other')} [role]
 * @property {Object.<ProviderId, ProviderOutcomeRef>} providers
 */

/**
 * Canonical representation of a specific tradeable market inside an event.
 *
 * @typedef {Object} CanonicalMarket
 * @property {string} id              - Canonical market ID (scoped under its event)
 * @property {string} eventId         - CanonicalEvent.id this belongs to
 * @property {('binary'|'multi-outcome'|'range'|'unknown')} type
 * @property {string} title           - Human-readable market title/question
 * @property {string} [category]      - Optional override of event category at market level
 * @property {string} [subcategory]
 * @property {string} [region]
 * @property {string|null} [tradeOpenAt]       - ISO timestamp when trading opens
 * @property {string|null} [tradeCloseAt]      - ISO timestamp when trading closes
 * @property {string|null} [expectedResolveAt] - ISO timestamp when resolution is expected
 * @property {string|null} [latestResolveAt]   - Hard upper bound for resolution time
 * @property {CanonicalOutcome[]} outcomes
 * @property {Object.<ProviderId, ProviderMarketRef>} providers
 */

/**
 * Canonical representation of a prediction-market event (e.g. election, series, tournament).
 *
 * @typedef {Object} CanonicalEvent
 * @property {string} id              - Stable, provider-agnostic slug (e.g. "us-election-2028-dem-nominee")
 * @property {string} title           - Human-readable event name
 * @property {string} category        - High-level domain ("politics", "sports", "crypto", "macro", etc.)
 * @property {string} [subcategory]   - Finer grain within category ("election", "league", "price-above", ...)
 * @property {string} [region]        - Region or scope ("US", "Canada", "Global", team/league key, etc.)
 * @property {string|null} [startTime]
 * @property {string|null} [endTime]
 * @property {string|null} [resolutionTime]
 * @property {Object.<ProviderId, ProviderEventRef>} providers
 * @property {CanonicalMarket[]} markets
 */

/**
 * Well-known provider identifiers.
 */
export const PROVIDER_IDS = Object.freeze({
  KALSHI: /** @type {ProviderId} */ ('kalshi'),
  POLYMARKET: /** @type {ProviderId} */ ('polymarket'),
});

/**
 * Normalize an arbitrary string into a stable kebab-case slug.
 * - Lowercases
 * - Trims whitespace
 * - Replaces any run of non-alphanumeric characters with a single dash
 * - Strips leading/trailing dashes
 *
 * This is intended for building canonical IDs from titles like:
 *   "Canada General Election 2026" -> "canada-general-election-2026"
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeSlug(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  // Replace any run of non-alphanumeric characters with a single dash.
  const dashed = trimmed.replace(/[^a-z0-9]+/g, '-');
  // Remove leading/trailing dashes.
  return dashed.replace(/^-+|-+$/g, '');
}

