import { tokenize } from './scoring.mjs';

export function normalizeTeamName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(fc|cf|sc|club|team)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function looksLikeMatchupMarket(market) {
  const title = String(market?.title || '').toLowerCase();
  if (!title) return false;
  if (/\b(vs\.?| at | @ )\b/.test(title)) return true;
  return false;
}

export function sportsEntityFromMarket(market) {
  const home = normalizeTeamName(market?.home_team || market?.homeTeam || '');
  const away = normalizeTeamName(market?.away_team || market?.awayTeam || '');
  const gameDate = String(market?.game_date || market?.gameDate || '').slice(0, 10) || null;
  const sport = String(market?.sport || '').toLowerCase() || 'unknown';
  const isMatchup = looksLikeMatchupMarket(market);
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
  const da = String(a || '').slice(0, 10);
  const db = String(b || '').slice(0, 10);
  if (!da || !db) return null;
  const ta = new Date(`${da}T00:00:00Z`).getTime();
  const tb = new Date(`${db}T00:00:00Z`).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round(Math.abs(ta - tb) / 86400000);
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
