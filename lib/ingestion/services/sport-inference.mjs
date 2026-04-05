/**
 * Sport inference helpers for Phase E1.2.
 * Converts Kalshi series tickers and Polymarket tag slugs into canonical sport codes.
 */

/**
 * Kalshi sport patterns — matched anywhere in series title (preferred) or ticker.
 * Order matters: more specific entries before generic ones.
 */
const KALSHI_TICKER_MAP = [
  [/\bNFL\b|pro.?football|super.?bowl/i,                                      'nfl'],
  [/\bNBA\b|pro.?basketball|nba.?finals/i,                                     'nba'],
  [/\bMLB\b|pro.?baseball|world.?series/i,                                     'mlb'],
  [/\bNHL\b|pro.?hockey|stanley.?cup/i,                                        'nhl'],
  [/\bNCAAFB\b|college.?football|ncaa.?football/i,                             'ncaaf'],
  [/\bNCAABB\b|college.?basketball|ncaa.?basketball|march.?madness/i,          'ncaab'],
  [/\bNCAAF?\b|\bNCAAB?\b|\bNCAAW?\b/i,                                        'ncaa'],
  [/\bUFC\b|\bMMA\b|mixed.?martial/i,                                          'mma'],
  // Esports — specific game titles first, then generic
  [/league.?of.?legends|\bLoL\b|dota.?2|\bCS[:\s]?GO\b|\bCS2\b|valorant|overwatch|rocket.?league|starcraft|hearthstone/i, 'esports'],
  [/\bE.?SPORTS\b/i,                                                           'esports'],
  // Soccer — international competitions
  [/\bUCL\b|champions.?league/i,                                               'soccer'],
  [/\bUEL\b|europa.?league/i,                                                  'soccer'],  // UEFA Europa League
  [/\bUECL\b|conference.?league/i,                                             'soccer'],  // UEFA Conference League
  [/\bEPL\b|premier.?league/i,                                                 'soccer'],
  [/\bFIFA\b|world.?cup/i,                                                     'soccer'],
  [/\bMLS\b/i,                                                                 'soccer'],
  [/\bLA.?LIGA\b|laliga/i,                                                     'soccer'],
  [/\bBUNDESLIGA\b/i,                                                          'soccer'],
  [/\bSERIE.?A\b|seriea/i,                                                     'soccer'],
  [/\bLIGUE.?1\b|ligue1/i,                                                     'soccer'],
  [/\bA.?LEAGUE\b/i,                                                           'soccer'],  // Australian A-League
  [/\bJ.?LEAGUE\b|j\.?league/i,                                                'soccer'],  // Japanese J1/J2/J3 League
  [/\bK.?LEAGUE\b/i,                                                           'soccer'],  // Korean K League
  [/\bLIGA.?PORTUGAL\b|primeira.?liga/i,                                       'soccer'],  // Portuguese league
  [/\bFA.?CUP\b|carabao|efl.?cup/i,                                            'soccer'],  // English cups
  [/\bEREDIVISIE\b/i,                                                          'soccer'],  // Dutch league
  [/\bSCOTTISH.?PREM/i,                                                        'soccer'],
  [/\bCOPA.?AMERICA\b|\bEURO.?20/i,                                            'soccer'],
  [/\bINTL?.?FRIENDLY\b|international.?friendly/i,                             'soccer'],
  [/brasile[ir]+o/i,                                                           'soccer'],  // Brazilian Brasileirao
  [/ballon.?d.?or/i,                                                           'soccer'],  // Ballon d'Or
  [/super.?lig\b/i,                                                            'soccer'],  // Turkish Süper Lig
  [/\bBELGIAN.?(?:PRO.?LEAGUE|PL)\b/i,                                        'soccer'],
  [/\bAPF\b|division.?de.?honor/i,                                             'soccer'],  // Paraguayan APF
  [/copa.?del.?rey/i,                                                          'soccer'],  // Spanish cup
  [/\bVEN.?FUT\b/i,                                                            'soccer'],  // Venezuelan football
  [/\bclub.?world/i,                                                           'soccer'],  // FIFA Club World Cup
  [/\bsoccer\b|\bfootball\b/i,                                                 'soccer'],
  // Tennis — ATP/WTA title patterns
  [/\bTENNIS\b|\bATP\b|\bWTA\b|wimbledon|french.?open|australian.?open|set.?winner/i, 'tennis'],
  [/\bGOLF\b|\bPGA\b|\bMASTERS\b|the.?masters|\bLIV\b/i,                      'golf'],
  [/\bF1\b|FORMULA.?1|formula.?one/i,                                          'f1'],
  [/\bBOXING\b/i,                                                              'boxing'],
  [/\bNASCAR\b|\bINDYCAR\b/i,                                                  'motorsport'],
  [/\bWRESTL/i,                                                                'wrestling'],
  // International basketball leagues
  [/\bB.?LEAGUE\b|japanese.?basketball/i,                                      'basketball'],  // Japan B.League
  [/\bCBA\b.{0,20}(?:game|match|basketball)/i,                                 'basketball'],  // Chinese Basketball Association
  [/\bNBL\b.{0,20}(?:game|match)/i,                                            'basketball'],  // Australian NBL
  // Rugby
  [/\bNRL\b|national.?rugby.?league/i,                                         'rugby'],
  [/\bsuper.?league.?rugby\b|\brugby.?league\b|\bRUGBY\b/i,                   'rugby'],
];

/**
 * Ticker-based fallback map — applied when title-only matching returns 'unknown'.
 * Matches against the raw Kalshi series ticker (e.g. "KXLOLGAME", "KXJBLEAGUEGAME").
 * Less preferred than title matching but catches series whose titles don't contain
 * standard keywords (e.g. "KXNHLEAST" with title "2025-26 NHL Eastern Conference").
 */
const KALSHI_SERIES_TICKER_FALLBACK = [
  [/LOLGAME|LOLESPORT|LOLESPORTS/i,                'esports'],
  [/JBLEAGUE/i,                                    'basketball'],   // Japanese B.League
  [/CBAGAME/i,                                     'basketball'],   // Chinese Basketball Association
  [/NBLGAME/i,                                     'basketball'],   // Australian NBL
  [/STEPHDEAL/i,                                   'nba'],          // Steph Curry deal (NBA)
  [/ATPSETWINNER|ATPGAMESPREAD|ATPGAME|WTASETWINNER|WTGAME|GRANDSLAMJ/i, 'tennis'],
  [/EXHIBITIONWOMEN|EXHIBITIONTENNIS/i,            'tennis'],       // tennis exhibition matches
  [/ALEAGUE/i,                                     'soccer'],       // Australian A-League
  [/JLEAGUE/i,                                     'soccer'],       // Japanese J-League
  [/KLEAGUE/i,                                     'soccer'],       // Korean K League
  [/LIGAPORTUGAL/i,                                'soccer'],       // Portuguese league
  [/UELSPREAD|UECL\b/i,                            'soccer'],       // Europa League / Conference League
  [/FACUP|CARABAO/i,                               'soccer'],       // English cups
  [/INTLFRIENDLY/i,                                'soccer'],       // International friendly
  [/CLUBWC/i,                                      'soccer'],       // FIFA Club World Cup
  [/BRASILE[IR]+O/i,                               'soccer'],       // Brasileirao
  [/BALLONDOR/i,                                   'soccer'],       // Ballon d'Or
  [/SUPERLIG(?!RUGBY)/i,                           'soccer'],       // Turkish Super Lig
  [/BELGIANPL/i,                                   'soccer'],       // Belgian Pro League
  [/VENFUT/i,                                      'soccer'],       // Venezuelan football
  [/APFDDH/i,                                      'soccer'],       // Paraguayan APF
  [/COPADELREY/i,                                  'soccer'],       // Copa del Rey
  [/WINSTREAKMANU/i,                               'soccer'],       // Manchester United streak
  [/IIHF/i,                                        'hockey'],       // IIHF ice hockey
  [/T20FOUR|T20TOTAL|IPL\b|CRICKET|BBLT20/i,       'cricket'],      // Cricket
  [/TGLCHAMPION|KFTOUR/i,                          'golf'],         // TGL/Korn Ferry golf
  [/WOFSKATE|WONORDIC|WO[A-Z]+/i,                  'olympics'],     // Winter Olympics events
  [/NRLCHAMP/i,                                    'rugby'],        // Australian NRL
  [/RUGBYESL|SUPERLIGRUGBY|SLRCHAMP/i,             'rugby'],        // Rugby Super League
  [/NCAAFMAC|NCAAFBIG|NCAAFSEC|NCAAFACE|NCAAFSUN/i, 'ncaaf'],      // NCAAF conferences
  [/NCAAMBAE|NCAAMBBSOU|NCAAMBIG|NCAAMBSEC/i,     'ncaab'],        // NCAAB conferences
  [/ACCREG|ACCTOURN/i,                             'ncaab'],        // ACC (basketball)
  [/NFLAFCNORTH|NFLNFCEAST|NFLAFCEAST|NFLNFCWEST|NFLAFCWEST|NFLAFCSOUTH|NFLNFCSOUTH/i, 'nfl'],
  [/RECORDNFLWORST|RECORDNFL/i,                    'nfl'],
  [/NHLEAST|NHLWEST|NHLCENTRAL|NHLPACIFIC|NHLATL/i, 'nhl'],
];

/**
 * Infer sport code from a Kalshi series title (and optionally the series ticker as fallback).
 * Prefer passing the human-readable series title — it's more reliable than KX-prefixed tickers.
 * When the title alone returns 'unknown', the optional seriesTicker is tried against
 * KALSHI_SERIES_TICKER_FALLBACK so tickers like "KXLOLGAME" still resolve correctly.
 *
 * @param {string} titleOrTicker  - Series title (preferred) or ticker
 * @param {string} [seriesTicker] - Raw Kalshi series ticker for fallback matching
 * @returns {string} sport code (nfl/nba/mlb/nhl/soccer/esports/basketball/rugby/unknown/…)
 */
export function inferSportFromKalshiTicker(titleOrTicker, seriesTicker) {
  if (!titleOrTicker || typeof titleOrTicker !== 'string') return 'unknown';

  // Primary: match against title
  for (const [pattern, sport] of KALSHI_TICKER_MAP) {
    if (pattern.test(titleOrTicker)) return sport;
  }

  // Fallback: match against raw series ticker when title produced no result
  if (seriesTicker && typeof seriesTicker === 'string') {
    for (const [pattern, sport] of KALSHI_SERIES_TICKER_FALLBACK) {
      if (pattern.test(seriesTicker)) return sport;
    }
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

/**
 * Polymarket tag slug substrings → sport code.
 */
const POLYMARKET_TAG_MAP = [
  ['nfl',              'nfl'],
  ['super-bowl',       'nfl'],
  ['nba',              'nba'],
  ['mlb',              'mlb'],
  ['world-series',     'mlb'],
  ['nhl',              'nhl'],
  ['stanley-cup',      'nhl'],
  ['ncaa',             'ncaa'],
  ['college-football', 'ncaaf'],
  ['college-basketball', 'ncaab'],
  ['ufc',              'mma'],
  ['mma',              'mma'],
  ['soccer',           'soccer'],
  ['football',         'soccer'],
  ['champions-league', 'soccer'],
  ['premier-league',   'soccer'],
  ['mls',              'soccer'],
  ['tennis',           'tennis'],
  ['golf',             'golf'],
  ['liv-golf',         'golf'],
  ['pga',              'golf'],
  ['formula-1',        'f1'],
  ['f1',               'f1'],
  ['boxing',           'boxing'],
  ['esports',          'esports'],
  ['sports',           'unknown'],  // generic fallback
];
