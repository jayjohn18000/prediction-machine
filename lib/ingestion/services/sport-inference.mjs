/**
 * Sport inference helpers for Phase E1.2.
 * Converts Kalshi series tickers and Polymarket tag slugs into canonical sport codes.
 */

/**
 * Kalshi series ticker prefix → sport code.
 * Order matters: more specific prefixes first.
 */
const KALSHI_TICKER_MAP = [
  [/^NFL/i,     'nfl'],
  [/^NFLSB/i,   'nfl'],   // Super Bowl sub-series
  [/^NBA/i,     'nba'],
  [/^NBAFS/i,   'nba'],   // Finals sub-series
  [/^MLB/i,     'mlb'],
  [/^MLBWS/i,   'mlb'],   // World Series sub-series
  [/^NHL/i,     'nhl'],
  [/^NHLSC/i,   'nhl'],   // Stanley Cup sub-series
  [/^NCAAFB/i,  'ncaaf'],
  [/^NCAABB/i,  'ncaab'],
  [/^NCAAF/i,   'ncaaf'],
  [/^NCAAB/i,   'ncaab'],
  [/^UFC/i,     'mma'],
  [/^MMA/i,     'mma'],
  [/^UCL/i,     'soccer'],
  [/^EPL/i,     'soccer'],
  [/^FIFA/i,    'soccer'],
  [/^MLS/i,     'soccer'],
  [/^LALIGA/i,  'soccer'],
  [/^BUNDESLIGA/i, 'soccer'],
  [/^SERIEA/i,  'soccer'],
  [/^LIGUE1/i,  'soccer'],
  [/^TENNIS/i,  'tennis'],
  [/^GOLF/i,    'golf'],
  [/^PGA/i,     'golf'],
  [/^MASTERS/i, 'golf'],
  [/^F1/i,      'f1'],
  [/^FORMULA/i, 'f1'],
  [/^BOXING/i,  'boxing'],
  [/^ESPORTS/i, 'esports'],
];

/**
 * Polymarket tag slug substrings → sport code.
 */
const POLYMARKET_TAG_MAP = [
  ['nfl',           'nfl'],
  ['super-bowl',    'nfl'],
  ['nba',           'nba'],
  ['mlb',           'mlb'],
  ['world-series',  'mlb'],
  ['nhl',           'nhl'],
  ['stanley-cup',   'nhl'],
  ['ncaa',          'ncaa'],
  ['college-football', 'ncaaf'],
  ['college-basketball', 'ncaab'],
  ['ufc',           'mma'],
  ['mma',           'mma'],
  ['soccer',        'soccer'],
  ['football',      'soccer'],
  ['champions-league', 'soccer'],
  ['premier-league',   'soccer'],
  ['mls',           'soccer'],
  ['tennis',        'tennis'],
  ['golf',          'golf'],
  ['pga',           'golf'],
  ['formula-1',     'f1'],
  ['f1',            'f1'],
  ['boxing',        'boxing'],
  ['esports',       'esports'],
  ['sports',        'unknown'],  // generic fallback
];

/**
 * Infer sport code from a Kalshi series ticker string.
 * Returns a sport code string (nfl/nba/mlb/nhl/soccer/unknown).
 * @param {string} ticker
 * @returns {string}
 */
export function inferSportFromKalshiTicker(ticker) {
  if (!ticker || typeof ticker !== 'string') return 'unknown';
  for (const [pattern, sport] of KALSHI_TICKER_MAP) {
    if (pattern.test(ticker)) return sport;
  }
  return 'unknown';
}

/**
 * Infer sport code from an array of Polymarket tag slug strings.
 * Returns the first matching sport code, or 'unknown'.
 * @param {string[]} tags
 * @returns {string}
 */
export function inferSportFromPolymarketTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return 'unknown';
  const normalized = tags.map((t) => String(t || '').toLowerCase());
  for (const [substring, sport] of POLYMARKET_TAG_MAP) {
    if (normalized.some((t) => t.includes(substring))) return sport;
  }
  return 'unknown';
}
