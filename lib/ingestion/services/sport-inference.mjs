/**
 * Sport inference helpers for PMCI market metadata.
 * Provides sport code detection from Polymarket tags and titles.
 * Pure functions - no side effects, no I/O, no DB.
 */

/**
 * Canonical sport codes used across the system.
 * Based on common league/sport identifiers.
 */
export const SPORT_CODES = Object.freeze({
  NFL: 'nfl',
  NBA: 'nba',
  MLB: 'mlb',
  NHL: 'nhl',
  MLS: 'mls',
  SOCCER: 'soccer',
  UFC: 'ufc',
  MMA: 'mma',
  BOXING: 'boxing',
  TENNIS: 'tennis',
  GOLF: 'golf',
  F1: 'f1',
  NASCAR: 'nascar',
  COLLEGE_FOOTBALL: 'cfb',
  COLLEGE_BASKETBALL: 'cbb',
  ESPORTS: 'esports',
  OLYMPICS: 'olympics',
  CRICKET: 'cricket',
  RUGBY: 'rugby',
  UNKNOWN: 'unknown_sport',
});

/**
 * Mapping from Polymarket tag labels/slugs to canonical sport codes.
 * Keys are lowercase normalized forms.
 */
const TAG_TO_SPORT_CODE = new Map([
  ['nfl', SPORT_CODES.NFL],
  ['football', SPORT_CODES.NFL],
  ['american-football', SPORT_CODES.NFL],
  ['super-bowl', SPORT_CODES.NFL],
  ['superbowl', SPORT_CODES.NFL],
  ['nba', SPORT_CODES.NBA],
  ['basketball', SPORT_CODES.NBA],
  ['mlb', SPORT_CODES.MLB],
  ['baseball', SPORT_CODES.MLB],
  ['world-series', SPORT_CODES.MLB],
  ['nhl', SPORT_CODES.NHL],
  ['hockey', SPORT_CODES.NHL],
  ['ice-hockey', SPORT_CODES.NHL],
  ['stanley-cup', SPORT_CODES.NHL],
  ['mls', SPORT_CODES.MLS],
  ['soccer', SPORT_CODES.SOCCER],
  ['football-soccer', SPORT_CODES.SOCCER],
  ['premier-league', SPORT_CODES.SOCCER],
  ['champions-league', SPORT_CODES.SOCCER],
  ['world-cup', SPORT_CODES.SOCCER],
  ['la-liga', SPORT_CODES.SOCCER],
  ['bundesliga', SPORT_CODES.SOCCER],
  ['serie-a', SPORT_CODES.SOCCER],
  ['ligue-1', SPORT_CODES.SOCCER],
  ['ufc', SPORT_CODES.UFC],
  ['mma', SPORT_CODES.MMA],
  ['mixed-martial-arts', SPORT_CODES.MMA],
  ['boxing', SPORT_CODES.BOXING],
  ['tennis', SPORT_CODES.TENNIS],
  ['wimbledon', SPORT_CODES.TENNIS],
  ['us-open', SPORT_CODES.TENNIS],
  ['australian-open', SPORT_CODES.TENNIS],
  ['french-open', SPORT_CODES.TENNIS],
  ['roland-garros', SPORT_CODES.TENNIS],
  ['golf', SPORT_CODES.GOLF],
  ['pga', SPORT_CODES.GOLF],
  ['masters', SPORT_CODES.GOLF],
  ['f1', SPORT_CODES.F1],
  ['formula-1', SPORT_CODES.F1],
  ['formula-one', SPORT_CODES.F1],
  ['nascar', SPORT_CODES.NASCAR],
  ['college-football', SPORT_CODES.COLLEGE_FOOTBALL],
  ['cfb', SPORT_CODES.COLLEGE_FOOTBALL],
  ['ncaa-football', SPORT_CODES.COLLEGE_FOOTBALL],
  ['college-basketball', SPORT_CODES.COLLEGE_BASKETBALL],
  ['cbb', SPORT_CODES.COLLEGE_BASKETBALL],
  ['ncaa-basketball', SPORT_CODES.COLLEGE_BASKETBALL],
  ['march-madness', SPORT_CODES.COLLEGE_BASKETBALL],
  ['esports', SPORT_CODES.ESPORTS],
  ['e-sports', SPORT_CODES.ESPORTS],
  ['gaming', SPORT_CODES.ESPORTS],
  ['olympics', SPORT_CODES.OLYMPICS],
  ['olympic-games', SPORT_CODES.OLYMPICS],
  ['summer-olympics', SPORT_CODES.OLYMPICS],
  ['winter-olympics', SPORT_CODES.OLYMPICS],
  ['cricket', SPORT_CODES.CRICKET],
  ['ipl', SPORT_CODES.CRICKET],
  ['rugby', SPORT_CODES.RUGBY],
  ['rugby-union', SPORT_CODES.RUGBY],
  ['rugby-league', SPORT_CODES.RUGBY],
]);

/**
 * Regex patterns for sport detection from titles (used when tags are numeric/opaque).
 */
const TITLE_SPORT_PATTERNS = [
  { pattern: /\b(NFL|National Football League)\b/i, code: SPORT_CODES.NFL },
  { pattern: /\b(Super Bowl|Superbowl)\b/i, code: SPORT_CODES.NFL },
  { pattern: /\b(NBA|National Basketball Association)\b/i, code: SPORT_CODES.NBA },
  { pattern: /\b(MLB|Major League Baseball)\b/i, code: SPORT_CODES.MLB },
  { pattern: /\b(World Series)\b/i, code: SPORT_CODES.MLB },
  { pattern: /\b(NHL|National Hockey League)\b/i, code: SPORT_CODES.NHL },
  { pattern: /\b(Stanley Cup)\b/i, code: SPORT_CODES.NHL },
  { pattern: /\b(MLS|Major League Soccer)\b/i, code: SPORT_CODES.MLS },
  { pattern: /\b(Premier League|Champions League|La Liga|Bundesliga|Serie A|Ligue 1)\b/i, code: SPORT_CODES.SOCCER },
  { pattern: /\b(World Cup)\b/i, code: SPORT_CODES.SOCCER },
  { pattern: /\b(UFC)\b/i, code: SPORT_CODES.UFC },
  { pattern: /\b(MMA|Mixed Martial Arts)\b/i, code: SPORT_CODES.MMA },
  { pattern: /\b(Boxing|Boxer|WBA|WBC|IBF|WBO)\b/i, code: SPORT_CODES.BOXING },
  { pattern: /\b(Tennis|Wimbledon|US Open|Australian Open|French Open|Roland Garros)\b/i, code: SPORT_CODES.TENNIS },
  { pattern: /\b(Golf|PGA|Masters|Ryder Cup)\b/i, code: SPORT_CODES.GOLF },
  { pattern: /\b(F1|Formula 1|Formula One|Grand Prix)\b/i, code: SPORT_CODES.F1 },
  { pattern: /\b(NASCAR|Daytona|Indy 500)\b/i, code: SPORT_CODES.NASCAR },
  { pattern: /\b(College Football|CFB|NCAAF)\b/i, code: SPORT_CODES.COLLEGE_FOOTBALL },
  { pattern: /\b(College Basketball|CBB|NCAAB|March Madness)\b/i, code: SPORT_CODES.COLLEGE_BASKETBALL },
  { pattern: /\b(Esports|E-sports|LoL|DOTA|CS:GO|Valorant)\b/i, code: SPORT_CODES.ESPORTS },
  { pattern: /\b(Olympics|Olympic Games)\b/i, code: SPORT_CODES.OLYMPICS },
  { pattern: /\b(Cricket|IPL|T20|Test Match)\b/i, code: SPORT_CODES.CRICKET },
  { pattern: /\b(Rugby)\b/i, code: SPORT_CODES.RUGBY },
];

/**
 * Normalize a Polymarket sport label/tag to lowercase slug form.
 * Strips whitespace, converts to lowercase, replaces spaces/underscores with hyphens.
 *
 * @param {string | null | undefined} label - Raw tag label from Polymarket
 * @returns {string} Normalized lowercase slug (e.g., "NFL Football" -> "nfl-football")
 */
export function normalizePolymarketSportLabel(label) {
  if (label == null || typeof label !== 'string') {
    return '';
  }

  return label
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Infer a sport code from Polymarket tags array.
 * Handles both descriptive tags (e.g., "NFL", "Basketball") and numeric/opaque tags.
 *
 * For numeric tags, falls back to title-based inference.
 *
 * @param {Array<string | { slug?: string; label?: string; id?: string | number }>} tags - Tags from Polymarket event
 * @param {string} [title] - Optional event/market title for fallback inference
 * @returns {{ sportCode: string; source: 'tag' | 'title' | 'none'; matchedTag?: string }}
 */
export function inferSportFromPolymarketTags(tags, title) {
  if (!Array.isArray(tags) || tags.length === 0) {
    return inferSportFromTitle(title);
  }

  for (const tag of tags) {
    const tagStr = extractTagString(tag);
    if (!tagStr) continue;

    const normalized = normalizePolymarketSportLabel(tagStr);
    if (!normalized) continue;

    const directMatch = TAG_TO_SPORT_CODE.get(normalized);
    if (directMatch) {
      return { sportCode: directMatch, source: 'tag', matchedTag: tagStr };
    }

    for (const [key, code] of TAG_TO_SPORT_CODE.entries()) {
      if (normalized.includes(key) || key.includes(normalized)) {
        return { sportCode: code, source: 'tag', matchedTag: tagStr };
      }
    }
  }

  return inferSportFromTitle(title);
}

/**
 * Infer sport code from title text using regex patterns.
 *
 * @param {string | null | undefined} title
 * @returns {{ sportCode: string; source: 'title' | 'none'; matchedTag?: undefined }}
 */
function inferSportFromTitle(title) {
  if (!title || typeof title !== 'string') {
    return { sportCode: SPORT_CODES.UNKNOWN, source: 'none' };
  }

  for (const { pattern, code } of TITLE_SPORT_PATTERNS) {
    if (pattern.test(title)) {
      return { sportCode: code, source: 'title' };
    }
  }

  return { sportCode: SPORT_CODES.UNKNOWN, source: 'none' };
}

/**
 * Extract a string representation from a tag (handles string or object form).
 *
 * @param {string | { slug?: string; label?: string; id?: string | number }} tag
 * @returns {string | null}
 */
function extractTagString(tag) {
  if (typeof tag === 'string') {
    return tag;
  }

  if (tag && typeof tag === 'object') {
    if (typeof tag.slug === 'string' && tag.slug) {
      return tag.slug;
    }
    if (typeof tag.label === 'string' && tag.label) {
      return tag.label;
    }
    if (typeof tag.id === 'string' && tag.id && !/^\d+$/.test(tag.id)) {
      return tag.id;
    }
  }

  return null;
}

/**
 * Check if a category string indicates a sports market.
 *
 * @param {string | null | undefined} category
 * @returns {boolean}
 */
export function isSportsCategory(category) {
  if (!category || typeof category !== 'string') {
    return false;
  }
  const normalized = category.toLowerCase().trim();
  return normalized === 'sports' || normalized === 'sport' || normalized.startsWith('sport');
}

/**
 * Get all valid sport codes.
 *
 * @returns {string[]}
 */
export function getAllSportCodes() {
  return Object.values(SPORT_CODES);
}
