/**
 * Sport inference helpers for Phase E1.2 / Phase G.
 * Converts Kalshi series tickers and Polymarket tag slugs into canonical sport codes.
 */

import { mapPolymarketSportSlug } from "../../normalization/sport-taxonomy.mjs";

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
  // E1.5: FC/football club team names → soccer (covers Polymarket matchup titles like
  // "Portsmouth FC vs. Leicester City FC" that don't contain "soccer" or "football")
  [/\bF\.?C\b(?!\s*\d)|\bfootball\s+club\b/i,                                'soccer'],
  // Additional soccer leagues (E1.5 round 2)
  [/\bSAUDI.?PRO.?LEAGUE\b|\bSAUDI.?PL\b/i,                                  'soccer'],
  [/\bNWSL\b|national.?women.?soccer/i,                                       'soccer'],
  [/\bUSL\b.{0,15}(?:championship|league|super)/i,                            'soccer'],
  [/baller.?league/i,                                                         'soccer'],
  [/thai.?league|thai.?premier/i,                                             'soccer'],
  [/conmebol.?lib|copa.?libertadores|copa.?sudamericana/i,                    'soccer'],
  [/\bserie.?b\b/i,                                                           'soccer'],  // Italian/Brazilian Serie B
  [/super.?league.{0,15}greece|hellenic.?super/i,                             'soccer'],
  [/pfa.{0,10}(?:player|award|year)/i,                                        'soccer'],  // PFA awards
  [/china.?super.?league|chinese.?super|csl\b/i,                              'soccer'],  // Chinese Super League
  [/efl.?championship|efl.?promo/i,                                           'soccer'],  // EFL Championship
  [/di.?mayor|primera.?a\b/i,                                                 'soccer'],  // Colombian Primera A
  [/argentino.?primera|arg.?primera/i,                                        'soccer'],  // Argentine Primera
  // Additional hockey leagues (E1.5 round 2)
  [/\bKHL\b|kontinental.?hockey/i,                                            'hockey'],  // KHL
  [/\bAHL\b|american.?hockey.?league/i,                                       'hockey'],  // AHL
  [/\bliiga\b|finnish.?hockey/i,                                              'hockey'],  // Finnish Liiga
  [/swiss.?(?:national.?)?league.{0,10}hockey|nla\b/i,                        'hockey'],  // Swiss NLA
  // Additional basketball leagues (E1.5 round 2)
  [/euroleague\b|eurocup.{0,5}basketball/i,                                   'basketball'],  // EuroLeague
  [/\bACB\b.{0,15}(?:league|basketball|game|season)/i,                        'basketball'],  // ACB Spain
  [/lnb.?elite|argentina.{0,15}basketball/i,                                  'basketball'],  // Argentine LNB
  [/bsl.{0,10}basketball|basketball.?super.?league/i,                         'basketball'],  // BSL
  // Additional esports (E1.5 round 2)
  [/rainbow.?six|\bR6\b.{0,10}(?:siege|esport|game)/i,                       'esports'],  // Rainbow Six
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
  [/NCAABASEBALL|GOLDENSPIKES/i,                     'baseball'],
  [/HEISMAN|NCAAF(?!B?B)|NCAAF[A-Z0-9]+/i,            'ncaaf'],
  [/NCAALAX|\bLAX\b/i,                             'lacrosse'],
  [/NHLPLAYOFF/i,                                     'nhl'],
  [/USL|EFL|UEL|EPL|LIGAMX|EKSTRAKLASA|PERLIGA|NEXTMANAGER|RONALDO|PREMCHAMP/i, 'soccer'],
  [/WNBADRAFT|NBAPLAYIN/i,                            'basketball'],
  [/MOTOGP/i,                                         'motorsport'],
  [/RYDERCUP|PGAEAGLE|PGABOGEYFREE|PGAAGECUT/i,       'golf'],
  [/CHESS/i,                                          'chess'],
  [/MLB.*(WINNER|INNINGS)|KBO|NPB|CHIBA|HANSHIN|DRAGONS|BAYSTARS|EAGLES/i, 'mlb'],
  // E1.5 round 2 — ticker fallbacks for series whose titles lack sport keywords
  [/CS2MAP|CS2GAME/i,                                  'esports'],      // Counter-Strike 2 maps/games
  [/R6GAME|R6SIEGE/i,                                  'esports'],      // Rainbow Six Siege
  [/NBAGAME|NBA1H(?:WINNER)?/i,                        'nba'],          // NBA game / first half
  [/NFLTEAM[0-9A-Z]*/i,                                'nfl'],          // NFL team position/records
  [/NCAAMLAX|NCAALAXFINAL|LAXTEWAARATON/i,              'lacrosse'],     // NCAA men's lacrosse
  [/SAUDIPL/i,                                         'soccer'],       // Saudi Pro League
  [/DIMAYOR/i,                                         'soccer'],       // Colombian Di Mayor
  [/KHLGAME/i,                                         'hockey'],       // KHL game
  [/THAIL[0-9]/i,                                      'soccer'],       // Thai League 1/2/3
  [/SERIEBGAME/i,                                      'soccer'],       // Serie B
  [/AFLGAME/i,                                         'aussierules'],  // Australian Football League
  [/BALLERLEAGUE/i,                                    'soccer'],       // Baller League
  [/CONMEBOLLIB|CONMEBOLSUD|CONMEBOL/i,                'soccer'],       // CONMEBOL competitions
  [/BSLGAME/i,                                         'basketball'],   // BSL Basketball
  [/EUROLEAGUE/i,                                      'basketball'],   // EuroLeague Basketball
  [/ACBGAME/i,                                         'basketball'],   // ACB Spanish basketball
  [/LNBELITE/i,                                        'basketball'],   // LNB Elite (Argentine)
  [/CHNSLGAME/i,                                       'soccer'],       // Chinese Super League
  [/NWSLGAME/i,                                        'soccer'],       // NWSL women's soccer
  [/PSLGAME/i,                                         'soccer'],       // PSL (South Africa)
  [/PFAPOY/i,                                          'soccer'],       // PFA Player of the Year
  [/SLGREECE/i,                                        'soccer'],       // Super League Greece
  [/ARGLNB/i,                                          'basketball'],   // Argentine LNB
  [/LIIGAGAME/i,                                       'hockey'],       // Finnish Liiga
  [/SWISSLEAGUE/i,                                     'hockey'],       // Swiss National League
  [/EFLCHAMPIONSHIP|EFLPROMO/i,                        'soccer'],       // EFL Championship/Promotion
  [/AHLGAME/i,                                         'hockey'],       // AHL (American Hockey League)
  [/ARGPREMDIV/i,                                      'soccer'],       // Argentine Primera División
  [/URYPDGAME/i,                                       'soccer'],       // Uruguayan football
  [/SWISSLEAGUE/i,                                     'hockey'],       // Swiss league (dedup guard)
  // E1.6 — Kalshi series tickers still landing as unknown_sport (bulk universe)
  [/NCAABBGAME|NCAABBGS/i,                             'ncaab'],
  [/KXMLBF5|KXMLBGAME|MLBF5TOTAL|MLBF5SPREAD/i,        'mlb'],
  [/ITFWMATCH|ITFWGAME/i,                              'tennis'],
  [/ISLGAME/i,                                         'soccer'],       // Israeli Premier League
  [/ALLSVENSKANGAME/i,                                 'soccer'],       // Allsvenskan
  [/HNLGAME/i,                                         'soccer'],       // Croatian HNL
  [/KXDELGAME/i,                                       'hockey'],       // DEL (Germany)
  [/SHLGAME/i,                                         'hockey'],       // Swedish Hockey League
  [/ABAGAME/i,                                         'basketball'],   // ABA / Australian basketball
  [/CHLLDP/i,                                          'soccer'],       // Chile league
  [/VTBGAME/i,                                         'tennis'],       // ITF / WTA style events on Kalshi
  [/CBASPREAD/i,                                       'ncaab'],
  [/BALGAME/i,                                         'soccer'],       // Belgian league
  [/MCGREGORFIGHTNEXT/i,                               'mma'],
  [/ECULP/i,                                           'soccer'],       // Ecuador
  [/NHLWEST|NHLEAST|NHLNORTH/i,                        'nhl'],
  [/FRA14CHAMP/i,                                      'soccer'],
  [/SAILGP/i,                                          'motorsport'],   // SailGP (racing series)
  [/KBLGAME/i,                                         'basketball'],   // Korean Basketball League
  [/NLGAME/i,                                          'soccer'],       // Dutch football
  [/GBLGAME/i,                                         'soccer'],       // Greek Super League
  [/EKSTRAKLASAGAME/i,                                'soccer'],       // Poland
  [/TURKEYGAME|TURKSLGAME/i,                           'soccer'],
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
 * Phase G: apply Polymarket sport-code alias map, then tag + title inference.
 * @param {string[]} tagBits - tag slugs, labels, or sport codes from Gamma
 * @param {string} title - market title / question
 * @returns {string}
 */
export function resolvePolymarketSport(tagBits, title) {
  const bits = (Array.isArray(tagBits) ? tagBits : []).map((t) => String(t || '').trim()).filter(Boolean);
  const mapped = [];
  let junkDrawerOnly = false;

  for (const b of bits) {
    const lower = b.toLowerCase();
    const alias = mapPolymarketSportSlug(lower);
    if (alias === undefined) {
      mapped.push(lower);
    } else if (alias === null) {
      junkDrawerOnly = true;
    } else {
      mapped.push(String(alias).toLowerCase());
    }
  }

  if (junkDrawerOnly && mapped.length === 0) {
    return inferSportFromKalshiTicker(String(title || ''));
  }

  const tagSource = mapped.length ? mapped : bits.map((b) => b.toLowerCase());
  let sport = inferSportFromPolymarketTags(tagSource);
  if (sport === 'unknown') {
    sport = inferSportFromKalshiTicker(String(title || ''));
  }
  return sport;
}

/**
 * Documented in docs/db-schema-reference.md — Polymarket title + optional tags.
 * @param {string} title
 * @param {string[]} [tagBits=[]]
 */
export function inferSportFromPolymarketTitle(title, tagBits = []) {
  return resolvePolymarketSport(tagBits, title);
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
