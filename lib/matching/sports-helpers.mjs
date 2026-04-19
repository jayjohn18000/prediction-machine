import { tokenize, jaccard } from './scoring.mjs';

export function normalizeTeamName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(fc|cf|sc|club|team)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalized string equality (cross-venue exact match after normalization). */
export function teamNamesExactMatch(a, b) {
  const x = normalizeTeamName(a);
  const y = normalizeTeamName(b);
  return Boolean(x && y && x === y);
}

/**
 * Fuzzy equivalence for team labels (abbrev vs full name, extra tokens).
 * Uses normalized tokens + Jaccard overlap; substring match counts as fuzzy.
 */
export function fuzzyTeamNamesMatch(a, b) {
  const x = normalizeTeamName(a);
  const y = normalizeTeamName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  const ta = x.split(/\s+/).filter((t) => t.length > 1);
  const tb = y.split(/\s+/).filter((t) => t.length > 1);
  if (!ta.length || !tb.length) return false;
  return jaccard(new Set(ta), new Set(tb)) >= 0.35;
}

export function looksLikeMatchupMarket(market) {
  const title = String(market?.title || '').toLowerCase();
  if (!title) return false;
  // "vs" and " @ " are unambiguous matchup separators.
  if (/\bvs\.?\b| @ /.test(title)) return true;
  // E1.5 fix: " at " is only a matchup separator when NOT followed by qualifier words
  // ("at least", "at most", "at once", etc.) — prevents false positives on titles like
  // "Will X win at least Y games this season?" being flagged as matchup markets.
  if (/ at (?!(?:least|most|once|all|any|the |a ))/.test(title)) return true;
  return false;
}

export function sportsEntityFromMarket(market) {
  const home = normalizeTeamName(market?.home_team || market?.homeTeam || '');
  const away = normalizeTeamName(market?.away_team || market?.awayTeam || '');
  // pg may return `date` columns as JS Date objects; handle both Date and string safely
  const rawDate = market?.game_date ?? market?.gameDate;
  const gameDate = rawDate instanceof Date
    ? rawDate.toISOString().slice(0, 10)
    : String(rawDate || '').slice(0, 10) || null;
  const sport = String(market?.sport || '').toLowerCase() || 'unknown';
  const isMatchup = looksLikeMatchupMarket(market) || (home.length > 0 && away.length > 0);
  const teams = [away, home].filter(Boolean);
  const matchupKey = isMatchup && teams.length === 2 ? [...teams].sort().join('_vs_') : 'unknown';
  return {
    sport,
    gameDate,
    home,
    away,
    matchupKey,
    isMatchup,
    signature: `${sport}:${matchupKey}:${gameDate || 'unknown'}`,
    tokens: tokenize(`${sport} ${away} ${home} ${gameDate || ''}`),
  };
}

export function sportsDateDeltaDays(a, b) {
  // Handle Date objects (pg may return date columns as Date) and ISO strings
  const toISO = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10);
  const da = toISO(a);
  const db = toISO(b);
  if (!da || !db) return null;
  const ta = new Date(`${da}T00:00:00Z`).getTime();
  const tb = new Date(`${db}T00:00:00Z`).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round(Math.abs(ta - tb) / 86400000);
}

// Market-type bucket classification for A3 event-type mismatch filtering
const BUCKET_PATTERNS = [
  { bucket: 'moneyline_winner', pattern: /\b(win|winner|match\s+winner|first\s+half\s+winner|1st\s+half\s+winner|halftime\s+winner)\b/i },
  { bucket: 'totals',           pattern: /\b(totals|over\/under|o\/u\s*[\d.]+)\b/i },
  // Team/game totals phrasing (e.g. "Will Minnesota score over 4.5 runs?") — not covered by "o/u" alone
  { bucket: 'totals',           pattern: /\b(over|under)\s+[\d.]+\s+runs\b/i },
  // Run-line margin (e.g. "Kansas City wins by over 2.5 runs?")
  { bucket: 'totals',           pattern: /\bwins by over\s+[\d.]+\s+runs\b/i },
  { bucket: 'btts',             pattern: /\b(both\s+teams?\s+to\s+score|btts)\b/i },
  { bucket: 'spread',           pattern: /\b(handicap|spread|[+-]\d+\.5)\b/i },
];

/** Canonical vocabulary template keys per bucket (aligned with classifyVocabularyTemplate / Phase E4 DB). */
export const SPORTS_BUCKET_TO_TEMPLATE = {
  moneyline_winner: 'sports-moneyline',
  totals: 'sports-total',
  spread: 'sports-spread',
  btts: 'sports-yes-no',
};

export function classifyMarketTypeBucket(title) {
  const t = String(title || '').toLowerCase();
  for (const { bucket, pattern } of BUCKET_PATTERNS) {
    if (pattern.test(t)) return bucket;
  }
  return null; // unknown — do not filter on unknown
}

export function isSportsPairSemanticallyValid(a, b) {
  const sa = sportsEntityFromMarket(a);
  const sb = sportsEntityFromMarket(b);
  if (!sa.sport || !sb.sport || sa.sport === 'unknown' || sb.sport === 'unknown') {
    return { ok: false, reason: 'sport_unknown' };
  }
  if (sa.sport !== sb.sport) {
    return { ok: false, reason: 'sport_mismatch', details: { sportA: sa.sport, sportB: sb.sport } };
  }
  const dateDelta = sportsDateDeltaDays(sa.gameDate, sb.gameDate);
  if (dateDelta != null && dateDelta > 1) {
    return { ok: false, reason: 'game_date_delta_gt_1', details: { dateDelta } };
  }
  if (sa.matchupKey === 'unknown' || sb.matchupKey === 'unknown') {
    return { ok: false, reason: 'missing_matchup' };
  }
  if (sa.matchupKey !== sb.matchupKey) {
    return { ok: false, reason: 'matchup_mismatch', details: { matchupA: sa.matchupKey, matchupB: sb.matchupKey } };
  }
  return { ok: true, details: { sport: sa.sport, matchupKey: sa.matchupKey, dateDelta } };
}
