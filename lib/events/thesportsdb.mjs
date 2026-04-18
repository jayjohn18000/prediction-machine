/**
 * TheSportsDB (free) — upcoming events per league.
 * @see docs/plans/phase-g-canonical-events-schema.md
 */

const DEFAULT_BASE = "https://www.thesportsdb.com/api/v1/json";

/** @type {Record<string, number>} Phase G doc league ids */
export const THESPORTSDB_LEAGUE_IDS = {
  MLB: 4424,
  NBA: 4387,
  NHL: 4380,
  MLS: 4346,
  EPL: 4328,
  LA_LIGA: 4335,
  BUNDESLIGA: 4331,
  SERIE_A: 4332,
  LIGUE_1: 4334,
  UCL: 4480,
};

/**
 * @param {{ leagueId: number, apiKey?: string, signal?: AbortSignal }} opts
 * @returns {Promise<object[]>} raw `events` array (may be null → [])
 */
export async function fetchNextEventsForLeague(opts) {
  const leagueId = opts?.leagueId;
  if (leagueId == null) return [];
  const key = opts?.apiKey || process.env.THESPORTSDB_API_KEY || "3";
  const base = process.env.THESPORTSDB_API_BASE || DEFAULT_BASE;
  const url = `${base}/${key}/eventsnextleague.php?id=${encodeURIComponent(String(leagueId))}`;
  const res = await fetch(url, { signal: opts?.signal });
  if (!res.ok) {
    console.warn(`TheSportsDB HTTP ${res.status} for league ${leagueId}`);
    return [];
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return [];
  }
  const events = data?.events;
  return Array.isArray(events) ? events : [];
}

/**
 * Map API row → normalized record for pmci.canonical_events upsert.
 * @param {object} ev
 * @param {{ subcategory: string }} ctx
 */
export function normalizeSportsDbEvent(ev, ctx = {}) {
  const id = ev?.idEvent != null ? String(ev.idEvent) : null;
  if (!id) return null;
  const away = String(ev?.strAwayTeam || "").trim();
  const home = String(ev?.strHomeTeam || "").trim();
  const title =
    String(ev?.strEvent || "").trim() ||
    (away && home ? `${away} @ ${home}` : away || home || `event-${id}`);
  const dateStr = ev?.dateEvent ? String(ev.dateEvent).slice(0, 10) : null;
  const timeStr = ev?.strTime ? String(ev.strTime) : null;
  let eventTime = null;
  if (dateStr && timeStr && /\d{2}:\d{2}/.test(timeStr)) {
    eventTime = new Date(`${dateStr}T${timeStr}:00Z`).toISOString();
  }
  const participants = [];
  if (away) participants.push({ name: away, role: "away" });
  if (home) participants.push({ name: home, role: "home" });

  return {
    slug: `thesportsdb-${id}`,
    title,
    category: "sports",
    subcategory: ctx.subcategory || null,
    event_date: dateStr,
    event_time: eventTime,
    participants,
    external_ref: id,
    external_source: "thesportsdb",
    metadata: {
      league: ev?.strLeague || null,
      league_id: ev?.idLeague || null,
      season: ev?.strSeason || null,
      round: ev?.intRound || null,
    },
  };
}
