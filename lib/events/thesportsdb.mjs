/**
 * TheSportsDB (free) — upcoming events per league.
 *
 * League IDs (verified via lookupleague.php + search_all_leagues US, 2026):
 * - MLB 4424, NBA 4387, NHL 4380
 *
 * Note: `eventsnextleague.php` on the public API often returns unrelated rows (wrong idLeague).
 * We filter by idLeague and fall back to `eventsday.php` by sport over a date horizon.
 *
 * @see docs/plans/phase-g-canonical-events-schema.md
 */

const DEFAULT_BASE = "https://www.thesportsdb.com/api/v1/json";

/** Browser-like UA reduces intermittent Cloudflare 1015 blocks on server-side fetch. */
const DEFAULT_FETCH_INIT = {
  headers: {
    Accept: "application/json",
    "User-Agent": "prediction-machine/1.0 (https://github.com/prediction-machine)",
  },
};

/** When lookupleague fails, eventsday still needs strSport (from lookupleague.php). */
const FALLBACK_SPORT_BY_LEAGUE_ID = {
  4424: "Baseball", // MLB
  4387: "Basketball", // NBA
  4380: "Ice Hockey", // NHL
};

/**
 * Verified TheSportsDB league ids (Major North American leagues).
 * @type {Record<string, number>}
 */
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

const leagueMetaCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cloudflare may return HTTP 429 or 200 + JSON with error_code 1015. */
function isCloudflareRateLimitPayload(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
      (Number(data.error_code) === 1015 || data.cloudflare_error === true),
  );
}

/**
 * Fetches JSON from TheSportsDB with retries (rate limits are common on the free tier).
 * @param {string} url
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<object | null>}
 */
async function fetchSportsDbJson(url, signal) {
  const max = Math.max(1, Number(process.env.THESPORTSDB_FETCH_RETRIES ?? 6));
  const baseDelay = Math.max(80, Number(process.env.THESPORTSDB_FETCH_BASE_DELAY_MS ?? 450));
  for (let attempt = 0; attempt < max; attempt++) {
    let res;
    let data;
    try {
      res = await fetch(url, { ...DEFAULT_FETCH_INIT, signal });
      data = await res.json();
    } catch {
      if (attempt < max - 1) await sleep(baseDelay * 2 ** attempt);
      else return null;
      continue;
    }
    if (res.ok && !isCloudflareRateLimitPayload(data)) return data;
    if (attempt < max - 1) await sleep(baseDelay * 2 ** attempt);
  }
  return null;
}

/**
 * @param {number} leagueId
 * @returns {Promise<{ strSport?: string, strLeague?: string } | null>}
 */
export async function fetchLeagueMetadata(leagueId) {
  if (leagueId == null) return null;
  const k = Number(leagueId);
  if (leagueMetaCache.has(k)) return leagueMetaCache.get(k);
  const key = process.env.THESPORTSDB_API_KEY || "3";
  const base = process.env.THESPORTSDB_API_BASE || DEFAULT_BASE;
  const url = `${base}/${key}/lookupleague.php?id=${encodeURIComponent(String(leagueId))}`;
  const data = await fetchSportsDbJson(url);
  if (!data) {
    leagueMetaCache.set(k, null);
    return null;
  }
  const row = data?.leagues?.[0] ?? null;
  leagueMetaCache.set(k, row);
  return row;
}

function addUtcDays(isoDateStr, deltaDays) {
  const d = new Date(`${isoDateStr}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * UTC calendar dates starting at "today" (UTC), inclusive, length `horizonDays`.
 * @param {number} horizonDays
 * @returns {string[]}
 */
export function buildRollingUtcDates(horizonDays = 14) {
  const n = Math.min(45, Math.max(1, horizonDays));
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (let i = 0; i < n; i++) out.push(addUtcDays(today, i));
  return out;
}

/**
 * @param {{ leagueId: number, apiKey?: string, signal?: AbortSignal, horizonDays?: number, dates?: string[] }} opts
 * - `dates`: optional explicit YYYY-MM-DD list (merged with rolling window when `mergeRollingDates` is true).
 * - `mergeRollingDates`: when true (default), union `dates` with [today .. today+horizonDays-1].
 * @returns {Promise<object[]>} raw `events` array (may be empty)
 */
export async function fetchNextEventsForLeague(opts) {
  const leagueId = opts?.leagueId;
  if (leagueId == null) return [];
  const key = opts?.apiKey || process.env.THESPORTSDB_API_KEY || "3";
  const base = process.env.THESPORTSDB_API_BASE || DEFAULT_BASE;
  const horizonDays = Math.min(30, Math.max(1, opts?.horizonDays ?? 14));
  const lid = String(leagueId);
  const mergeRolling = opts?.mergeRollingDates !== false;

  /** @type {Set<string>} */
  const dateSet = new Set();
  if (mergeRolling) {
    for (const d of buildRollingUtcDates(horizonDays)) dateSet.add(d);
  }
  const extra = opts?.dates;
  if (Array.isArray(extra)) {
    for (const d of extra) {
      if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) dateSet.add(d);
    }
  }
  if (dateSet.size === 0) {
    for (const d of buildRollingUtcDates(horizonDays)) dateSet.add(d);
  }

  const datesToFetch = [...dateSet].sort();

  /** @type {Map<string, object>} */
  const byEvent = new Map();

  const nextUrl = `${base}/${key}/eventsnextleague.php?id=${encodeURIComponent(lid)}`;
  const nextData = await fetchSportsDbJson(nextUrl, opts?.signal);
  if (nextData) {
    const events = nextData?.events;
    if (Array.isArray(events)) {
      for (const ev of events) {
        if (String(ev?.idLeague ?? "") === lid) {
          byEvent.set(String(ev.idEvent), ev);
        }
      }
    }
  }

  const gap = Math.max(0, Number(process.env.THESPORTSDB_DAY_FETCH_GAP_MS ?? 180));
  for (let i = 0; i < datesToFetch.length; i++) {
    if (i > 0 && gap > 0) await sleep(gap);
    const d = datesToFetch[i];
    /** Prefer league id — full-day schedule per league (not sport-wide `s=`). */
    const dayUrl = `${base}/${key}/eventsday.php?d=${encodeURIComponent(d)}&l=${encodeURIComponent(lid)}`;
    const dayData = await fetchSportsDbJson(dayUrl, opts?.signal);
    if (!dayData) continue;
    const dayEvents = dayData?.events;
    if (!Array.isArray(dayEvents)) continue;
    for (const ev of dayEvents) {
      if (String(ev?.idLeague ?? "") !== lid) continue;
      const id = ev?.idEvent != null ? String(ev.idEvent) : null;
      if (id) byEvent.set(id, ev);
    }
  }

  return [...byEvent.values()];
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
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && timeStr) {
    const hm = timeStr.match(/(\d{1,2}):(\d{2})/);
    if (hm) {
      const hh = String(hm[1]).padStart(2, "0");
      const mm = hm[2].padStart(2, "0");
      const d = new Date(`${dateStr}T${hh}:${mm}:00.000Z`);
      if (!Number.isNaN(d.getTime())) eventTime = d.toISOString();
    }
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
