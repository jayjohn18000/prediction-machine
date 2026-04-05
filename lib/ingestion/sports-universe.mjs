/**
 * Sports universe constants and configuration for PMCI sport ingestion.
 * Defines known tickers, tag IDs, and mapping tables.
 */

import {
  SPORT_CODES,
  normalizePolymarketSportLabel,
  inferSportFromPolymarketTags,
  isSportsCategory,
} from './services/sport-inference.mjs';

export { SPORT_CODES, normalizePolymarketSportLabel, inferSportFromPolymarketTags, isSportsCategory };

/**
 * Known Kalshi series tickers for sports markets.
 * These are discovered via API exploration and may expand over time.
 */
export const KALSHI_SPORTS_SERIES_TICKERS = Object.freeze([
  'KXNFL',
  'KXNBA',
  'KXMLB',
  'KXNHL',
  'KXUFC',
  'KXGOLF',
  'KXTENNIS',
  'KXSOCCER',
  'KXMMA',
]);

/**
 * Known Polymarket tag IDs for sports categories.
 * Numeric IDs may change; use descriptive tags when available.
 */
export const POLYMARKET_SPORTS_TAG_IDS = Object.freeze([
  'sports',
  'nfl',
  'nba',
  'mlb',
  'nhl',
  'ufc',
  'mma',
  'soccer',
  'tennis',
  'golf',
]);

/**
 * Previously unknown/problematic tickers that have been mapped.
 * Used for regression testing to ensure these continue to resolve correctly.
 */
export const REGRESSION_TICKERS = Object.freeze([
  { ticker: 'KXNFL-SUPERBOWL-2026', expectedSport: SPORT_CODES.NFL },
  { ticker: 'KXNBA-FINALS-2026', expectedSport: SPORT_CODES.NBA },
  { ticker: 'KXMLB-WS-2026', expectedSport: SPORT_CODES.MLB },
  { ticker: 'KXUFC-300', expectedSport: SPORT_CODES.UFC },
  { ticker: 'KXMMA-BELLATOR', expectedSport: SPORT_CODES.MMA },
]);

/**
 * Mapping from Kalshi series ticker prefixes to sport codes.
 */
export const KALSHI_TICKER_TO_SPORT = Object.freeze({
  KXNFL: SPORT_CODES.NFL,
  KXNBA: SPORT_CODES.NBA,
  KXMLB: SPORT_CODES.MLB,
  KXNHL: SPORT_CODES.NHL,
  KXUFC: SPORT_CODES.UFC,
  KXMMA: SPORT_CODES.MMA,
  KXGOLF: SPORT_CODES.GOLF,
  KXTENNIS: SPORT_CODES.TENNIS,
  KXSOCCER: SPORT_CODES.SOCCER,
  KXNASCAR: SPORT_CODES.NASCAR,
  KXF1: SPORT_CODES.F1,
});

/**
 * Infer sport code from a Kalshi series ticker.
 *
 * @param {string} ticker - Kalshi series or event ticker
 * @returns {string} Sport code or 'unknown_sport'
 */
export function inferSportFromKalshiTicker(ticker) {
  if (!ticker || typeof ticker !== 'string') {
    return SPORT_CODES.UNKNOWN;
  }

  const upper = ticker.toUpperCase();

  for (const [prefix, code] of Object.entries(KALSHI_TICKER_TO_SPORT)) {
    if (upper.startsWith(prefix) || upper.includes(prefix)) {
      return code;
    }
  }

  return SPORT_CODES.UNKNOWN;
}

/**
 * Check if a Kalshi ticker is a known sports ticker.
 *
 * @param {string} ticker
 * @returns {boolean}
 */
export function isKalshiSportsTicker(ticker) {
  return inferSportFromKalshiTicker(ticker) !== SPORT_CODES.UNKNOWN;
}
