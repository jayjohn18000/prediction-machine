/**
 * Sport inference helpers for Phase E1.2 / Phase G.
 * Converts Kalshi series tickers and Polymarket tag slugs into canonical sport codes.
 */

import { mapPolymarketSportSlug } from "../../normalization/sport-taxonomy.mjs";

/**
 * Classifier version — bump on any material change to the Polymarket sport-inference rules.
 * v2-h2h (Phase Linker H2H Expansion, 2026-04-24): added numeric tag_id map, event_ref/slug
 * prefix fallback for soccer leagues, and slug-fragment title fallback.
 */
export const POLYMARKET_SPORT_CLASSIFIER_VERSION = 'v2-h2h';

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
 * Try to resolve a Polymarket sport via numeric tag_id map (v2-h2h).
 * @param {string[]|string} tagBits
 * @param {string|number} [tagId]
 * @returns {string} canonical sport code, or 'unknown'
 */
export function inferSportFromPolymarketTagId(tagBits, tagId) {
  const candidates = [];
  if (tagId != null) candidates.push(String(tagId).trim());
  if (Array.isArray(tagBits)) {
    for (const b of tagBits) {
      const s = String(b ?? '').trim();
      if (s && /^\d+$/.test(s)) candidates.push(s);
    }
  }
  for (const c of candidates) {
    const hit = POLYMARKET_TAG_ID_MAP.get(c);
    if (hit) return hit;
  }
  return 'unknown';
}

/**
 * v2-h2h: soccer slug/prefix fallback. Inspects event_ref, slug, and title for
 * unambiguous soccer-league fragments; otherwise returns 'unknown'. Narrow by
 * design — avoid guessing sport from short team-name tokens.
 * @param {{ event_ref?: string, slug?: string, title?: string }} ctx
 * @returns {string}
 */
export function inferSportFromPolymarketSlugOrTitle(ctx) {
  const ref = String(ctx?.event_ref || '').toLowerCase();
  const slug = String(ctx?.slug || '').toLowerCase();
  const title = String(ctx?.title || '').toLowerCase();

  // event_ref prefix is the strongest single signal — check it first
  if (ref) {
    const head = ref.split('-')[0];
    if (head) {
      const hit = POLYMARKET_EVENT_REF_PREFIX_MAP.get(head);
      if (hit) return hit;
    }
  }

  const haystacks = [ref, slug, title];
  for (const frag of SOCCER_LEAGUE_SLUGS) {
    for (const h of haystacks) {
      if (!h) continue;
      if (h.includes(frag)) return 'soccer';
    }
  }
  return 'unknown';
}

/**
 * Phase G: apply Polymarket sport-code alias map, then tag + title inference.
 * v2-h2h (Phase Linker H2H Expansion): also consult numeric tag_id map and
 * conservative event_ref/slug-based soccer fallback before returning 'unknown'.
 *
 * @param {string[]} tagBits - tag slugs, labels, or sport codes from Gamma
 * @param {string}   title   - market title / question
 * @param {{ tag_id?: string|number, event_ref?: string, slug?: string }} [ctx]
 *   optional per-market hints used by v2-h2h fallbacks
 * @returns {string}
 */
export function resolvePolymarketSport(tagBits, title, ctx = {}) {
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

  // v2-h2h: tag_id fast path — authoritative when matched
  const tagIdHit = inferSportFromPolymarketTagId(bits, ctx?.tag_id);
  if (tagIdHit !== 'unknown') return tagIdHit;

  if (junkDrawerOnly && mapped.length === 0) {
    const t = inferSportFromKalshiTicker(String(title || ''));
    if (t !== 'unknown') return t;
    return inferSportFromPolymarketSlugOrTitle({ ...ctx, title });
  }

  const tagSource = mapped.length ? mapped : bits.map((b) => b.toLowerCase());
  let sport = inferSportFromPolymarketTags(tagSource);
  if (sport === 'unknown') {
    sport = inferSportFromKalshiTicker(String(title || ''));
  }
  if (sport === 'unknown') {
    // v2-h2h conservative fallback: event_ref prefix + league-slug fragments.
    sport = inferSportFromPolymarketSlugOrTitle({ ...ctx, title });
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
 * Phase Linker H2H Expansion (v2-h2h): added soccer-league slug fragments so
 * league-specific slugs (e.g. "la-liga", "bundesliga") classify as canonical
 * 'soccer' — matching Kalshi's convention. Finer-grained per-league slugs stay
 * coarse on purpose; bilateral pairing requires same-sport, not same-league.
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
  // v2-h2h: additional soccer league slugs (Polymarket /sports + /tags endpoints)
  ['la-liga',          'soccer'],
  ['laliga',           'soccer'],
  ['bundesliga',       'soccer'],
  ['serie-a',          'soccer'],
  ['seriea',           'soccer'],
  ['ligue-1',          'soccer'],
  ['ligue1',           'soccer'],
  ['eredivisie',       'soccer'],
  ['europa-league',    'soccer'],
  ['conference-league', 'soccer'],
  ['copa-libertadores', 'soccer'],
  ['copa-sudamericana', 'soccer'],
  ['saudi-pro-league', 'soccer'],
  ['nwsl',             'soccer'],
  ['brasileirao',      'soccer'],
  // Tennis / golf / motorsport / esports
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

/**
 * Polymarket numeric tag_id → sport. Derived from correlating production
 * `pmci.provider_markets.metadata->>'tag_id'` against already-classified sport
 * labels on 2026-04-24 (see docs/pivot/artifacts/linker-h2h-diagnostic-2026-04-24.md).
 *
 * Entries are included only when the tag_id's classified rows overwhelmingly
 * map to a single sport (≥ 95% of rows that were classified under that tag_id).
 * This is the authoritative fast path when tag slugs are numeric-only.
 */
export const POLYMARKET_TAG_ID_MAP = new Map([
  // Soccer — league-specific tag_ids (all normalize to 'soccer')
  ['100100',  'soccer'],  // MLS
  ['100350',  'soccer'],  // generic soccer / multi-league
  ['100977',  'soccer'],
  ['101232',  'tennis'],  // tennis ATP/WTA
  ['101735',  'soccer'],  // Eredivisie (NL)
  ['101772',  'soccer'],  // Portugal Primeira
  ['101787',  'soccer'],  // UEL
  ['101988',  'soccer'],
  ['102008',  'soccer'],  // Serie A IT
  ['102070',  'soccer'],
  ['102123',  'tennis'],
  ['102154',  'soccer'],  // DFB Pokal
  ['102448',  'soccer'],  // Liga MX
  ['102561',  'soccer'],  // Argentina Primera
  ['102562',  'soccer'],  // Copa Libertadores
  ['102563',  'soccer'],  // Copa Sudamericana
  ['102564',  'soccer'],  // Turkish Super Lig
  ['102593',  'soccer'],  // Russian Premier
  ['102604',  'soccer'],  // Ligue 1
  ['102648',  'soccer'],  // Brasileirao
  ['102649',  'soccer'],  // J1 League
  ['102650',  'soccer'],  // Saudi Pro League
  ['102651',  'soccer'],  // Norwegian Eliteserien
  ['102652',  'soccer'],  // Danish Superliga
  ['102763',  'soccer'],  // Coupe de France
  ['102764',  'soccer'],
  ['102765',  'soccer'],
  ['102770',  'soccer'],  // J2 League
  ['102771',  'soccer'],
  ['103095',  'soccer'],
  ['103886',  'soccer'],  // Ukrainian Premier
  ['780',     'soccer'],
  ['1234',    'soccer'],
  ['1494',    'soccer'],
  // NHL
  ['100088',  'nhl'],
  // NFL
  ['450',     'nfl'],
  ['101680',  'nfl'],
  // NBA / basketball
  ['28',      'nba'],
  ['745',     'nba'],
  ['101178',  'nba'],
  ['102669',  'basketball'],
  ['104349',  'basketball'],
  // MLB
  ['678',     'mlb'],
  // Hockey (non-NHL)
  ['102907',  'hockey'],
  ['102908',  'hockey'],
  // Esports
  ['65',      'esports'],
  // Notably NOT mapped: tag_id=1 and tag_id=100639 ("Sports"/"Combat Sports" generic
  // parents) — they span multiple sports; defer to title-based inference.
]);

/**
 * v2-h2h: conservative slug/title fragments that deterministically imply soccer.
 * Matched case-insensitively against event_ref, slug, AND title strings. Keep
 * narrow — only include fragments that UNAMBIGUOUSLY name a soccer competition.
 */
export const SOCCER_LEAGUE_SLUGS = [
  'mls',
  'premier-league', 'premier league', 'epl',
  'la-liga', 'la liga', 'laliga',
  'bundesliga',
  'serie-a', 'serie a',
  'ligue-1', 'ligue 1',
  'eredivisie',
  'saudi-pro-league', 'saudi pro league',
  'champions-league', 'champions league',
  'europa-league', 'europa league',
  'conference-league',
  'copa-libertadores', 'copa libertadores',
  'copa-sudamericana', 'copa sudamericana',
  'copa-del-rey',
  'nwsl',
  'brasileirao',
];

/**
 * v2-h2h: Polymarket event_ref prefix → sport. Prefixes observed in
 * `pmci.provider_markets.event_ref` for Polymarket rows follow a compact
 * three-to-five-letter league code convention (e.g. `mls-`, `j1100-`, `spl-`).
 * Matched as the first `-` token of event_ref.
 */
export const POLYMARKET_EVENT_REF_PREFIX_MAP = new Map([
  // Soccer
  ['mls',      'soccer'],
  ['nwsl',     'soccer'],
  ['epl',      'soccer'],
  ['uel',      'soccer'],    // UEFA Europa League
  ['uecl',     'soccer'],    // UEFA Conference League
  ['ucl',      'soccer'],    // UEFA Champions League
  ['cdr',      'soccer'],    // Copa del Rey
  ['dfb',      'soccer'],    // DFB Pokal
  ['ptc',      'soccer'],    // Portuguese cup (Taça de Portugal)
  ['itc',      'soccer'],    // Italian Coppa
  ['nlc',      'soccer'],    // Dutch KNVB Cup
  ['cde',      'soccer'],    // Coupe de France
  ['fpd',      'soccer'],    // Costa Rica Primera
  ['spl',      'soccer'],    // Saudi Pro League
  ['ere',      'soccer'],    // Eredivisie
  ['bra',      'soccer'],    // Brasileirao Serie A
  ['bra2',     'soccer'],    // Brasileirao Serie B
  ['arg',      'soccer'],    // Argentine Primera
  ['mex',      'soccer'],    // Liga MX
  ['por',      'soccer'],    // Portugal Primeira
  ['nor',      'soccer'],    // Norwegian Eliteserien
  ['den',      'soccer'],    // Danish Superliga
  ['rus',      'soccer'],    // Russian Premier League
  ['tur',      'soccer'],    // Turkish Super Lig
  ['gtm',      'soccer'],    // Guatemalan Primera
  ['egy1',     'soccer'],    // Egyptian Premier
  ['per1',     'soccer'],    // Peruvian Primera
  ['col1',     'soccer'],    // Colombian Primera
  ['col',      'soccer'],    // Colombian league (legacy)
  ['bol1',     'soccer'],    // Bolivian Primera
  ['hr1',      'soccer'],    // Croatian HNL
  ['svk1',     'soccer'],    // Slovakian Super Liga
  ['cze1',     'soccer'],    // Czech Fortuna Liga
  ['rou1',     'soccer'],    // Romanian SuperLiga
  ['ukr1',     'soccer'],    // Ukrainian Premier
  ['j1100',    'soccer'],    // J1 League
  ['j2100',    'soccer'],    // J2 League
  ['j1',       'soccer'],
  ['j2',       'soccer'],
  ['lib',      'soccer'],    // Copa Libertadores
  ['sud',      'soccer'],    // Copa Sudamericana
  ['isp',      'soccer'],    // Indian Super League
  ['grc',      'soccer'],    // Greek Super League
  ['el2',      'soccer'],    // EFL League 2
  // Ice hockey / NHL
  ['nhl',      'nhl'],
  // Baseball
  ['mlb',      'mlb'],
  ['kbo',      'mlb'],       // KBO baseball — canonicalize to mlb for sport-equality
  // Basketball (European competitions surface as 'basketball')
  ['bkcl',     'basketball'],
  ['bkvtb',    'basketball'],
  // Esports
  ['lol',      'esports'],
  // Cricket stays opaque — not bilateral-addressable against Kalshi
]);
