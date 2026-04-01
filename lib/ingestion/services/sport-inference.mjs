/**
 * Sport inference helpers for Phase E1.2.
 * Converts Kalshi series tickers and Polymarket tag slugs into canonical sport codes.
 */

/**
 * Kalshi sport patterns — matched anywhere in ticker OR series title.
 * Kalshi tickers are KX-prefixed (e.g. KXNFLWINS-ATL) so start-of-string matching fails.
 * We pass series titles ("Pro football exact wins SF") which are more reliable.
 * Order matters: more specific entries before generic ones.
 */
const KALSHI_TICKER_MAP = [
  [/\bNFL\b|pro.?football|super.?bowl/i,                           'nfl'],
  [/\bNBA\b|pro.?basketball|nba.?finals/i,                         'nba'],
  [/\bMLB\b|pro.?baseball|world.?series/i,                         'mlb'],
  [/\bNHL\b|pro.?hockey|stanley.?cup/i,                            'nhl'],
  [/\bNCAAFB\b|college.?football|ncaa.?football/i,                 'ncaaf'],
  [/\bNCAABB\b|college.?basketball|ncaa.?basketball|march.?madness/i, 'ncaab'],
  [/\bNCAAF?\b|\bNCAAB?\b|\bNCAAW?\b/i,                            'ncaa'],
  [/\bUFC\b|\bMMA\b|mixed.?martial/i,                              'mma'],
  [/\bUCL\b|champions.?league/i,                                   'soccer'],
  [/\bEPL\b|premier.?league/i,                                     'soccer'],
  [/\bFIFA\b|world.?cup/i,                                         'soccer'],
  [/\bMLS\b/i,                                                     'soccer'],
  [/\bLA.?LIGA\b|laliga/i,                                         'soccer'],
  [/\bBUNDESLIGA\b/i,                                              'soccer'],
  [/\bSERIE.?A\b|seriea/i,                                         'soccer'],
  [/\bLIGUE.?1\b|ligue1/i,                                         'soccer'],
  [/\bsoccer\b/i,                                                  'soccer'],
  [/\bTENNIS\b|\bATP\b|\bWTA\b|wimbledon|french.?open|australian.?open/i, 'tennis'],
  [/\bGOLF\b|\bPGA\b|\bMASTERS\b|the.?masters/i,                   'golf'],
  [/\bF1\b|FORMULA.?1|formula.?one/i,                              'f1'],
  [/\bBOXING\b/i,                                                  'boxing'],
  [/\bNASCAR\b|\bINDYCAR\b/i,                                      'motorsport'],
  [/\bWRESTL/i,                                                    'wrestling'],
  [/\bE.?SPORTS\b/i,                                               'esports'],
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
 * Infer sport code from a Kalshi series ticker OR series title string.
 * Prefer passing the human-readable series title when available — it's more reliable
 * than KX-prefixed tickers (e.g. "Pro football exact wins SF" → 'nfl').
 * Returns a sport code string (nfl/nba/mlb/nhl/soccer/unknown).
 * @param {string} tickerOrTitle
 * @returns {string}
 */
export function inferSportFromKalshiTicker(tickerOrTitle) {
  if (!tickerOrTitle || typeof tickerOrTitle !== 'string') return 'unknown';
  for (const [pattern, sport] of KALSHI_TICKER_MAP) {
    if (pattern.test(tickerOrTitle)) return sport;
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
