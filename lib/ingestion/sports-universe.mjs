/**
 * Sports universe ingestion: Polymarket sports events via /sports endpoint.
 * Uses tagSlug as primary sport source, falls back to inferSportFromPolymarketTags.
 * Phase E1.5 — Part 1: Sport inference logic.
 */

const POLYMARKET_BASE = "https://gamma-api.polymarket.com";

/**
 * Mapping of Polymarket sport label variations to canonical sport names.
 * Keys are lowercase normalized labels; values are canonical sport identifiers.
 */
const SPORT_LABEL_MAP = new Map([
  // Basketball
  ["basketball", "basketball"],
  ["nba", "basketball"],
  ["ncaa-basketball", "basketball"],
  ["ncaab", "basketball"],
  ["college-basketball", "basketball"],
  ["wnba", "basketball"],
  // Football
  ["football", "football"],
  ["nfl", "football"],
  ["american-football", "football"],
  ["ncaa-football", "football"],
  ["ncaaf", "football"],
  ["college-football", "football"],
  // Soccer
  ["soccer", "soccer"],
  ["football-soccer", "soccer"],
  ["mls", "soccer"],
  ["premier-league", "soccer"],
  ["champions-league", "soccer"],
  ["world-cup", "soccer"],
  ["la-liga", "soccer"],
  ["bundesliga", "soccer"],
  ["serie-a", "soccer"],
  ["ligue-1", "soccer"],
  // Baseball
  ["baseball", "baseball"],
  ["mlb", "baseball"],
  // Hockey
  ["hockey", "hockey"],
  ["nhl", "hockey"],
  ["ice-hockey", "hockey"],
  // Tennis
  ["tennis", "tennis"],
  ["atp", "tennis"],
  ["wta", "tennis"],
  ["grand-slam", "tennis"],
  // Golf
  ["golf", "golf"],
  ["pga", "golf"],
  ["pga-tour", "golf"],
  // MMA/Fighting
  ["mma", "mma"],
  ["ufc", "mma"],
  ["boxing", "boxing"],
  ["fighting", "mma"],
  // Motorsports
  ["motorsports", "motorsports"],
  ["f1", "motorsports"],
  ["formula-1", "motorsports"],
  ["nascar", "motorsports"],
  ["racing", "motorsports"],
  // Cricket
  ["cricket", "cricket"],
  ["ipl", "cricket"],
  // Esports
  ["esports", "esports"],
  ["e-sports", "esports"],
  ["gaming", "esports"],
  // Other
  ["olympics", "olympics"],
  ["horse-racing", "horse-racing"],
  ["rugby", "rugby"],
]);

/**
 * Generic/ambiguous slugs that should trigger fallback to tag inference.
 * These are too broad to use as a reliable sport identifier.
 */
const GENERIC_SPORT_SLUGS = new Set([
  "sports",
  "sport",
  "games",
  "events",
  "live",
  "betting",
  "odds",
  "matches",
  "competitions",
  "tournaments",
  "leagues",
]);

/**
 * Normalize a Polymarket sport label to a canonical sport identifier.
 *
 * @param {string | null | undefined} label - Raw sport label from Polymarket
 * @returns {string | null} Canonical sport identifier or null if unrecognized
 */
export function normalizePolymarketSportLabel(label) {
  if (!label || typeof label !== "string") {
    return null;
  }

  const normalized = label
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");

  if (!normalized) {
    return null;
  }

  // Direct lookup
  if (SPORT_LABEL_MAP.has(normalized)) {
    return SPORT_LABEL_MAP.get(normalized);
  }

  // Partial match: check if any known sport is contained in the label
  for (const [key, value] of SPORT_LABEL_MAP.entries()) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return value;
    }
  }

  return null;
}

/**
 * Check if a tagSlug is generic (too broad to use as sport identifier).
 *
 * @param {string | null | undefined} tagSlug
 * @returns {boolean}
 */
function isGenericSlug(tagSlug) {
  if (!tagSlug || typeof tagSlug !== "string") {
    return true;
  }
  const normalized = tagSlug.toLowerCase().trim();
  return GENERIC_SPORT_SLUGS.has(normalized);
}

/**
 * Infer sport from an array of Polymarket tag slugs.
 * Used as fallback when tagSlug from /sports endpoint is generic or missing.
 *
 * @param {string[]} tagSlugs - Array of tag slugs from market/event
 * @returns {string | null} Canonical sport identifier or null if cannot infer
 */
export function inferSportFromPolymarketTags(tagSlugs) {
  if (!Array.isArray(tagSlugs) || tagSlugs.length === 0) {
    return null;
  }

  // Try each tag in order (first match wins)
  for (const slug of tagSlugs) {
    if (!slug || typeof slug !== "string") continue;

    const normalized = normalizePolymarketSportLabel(slug);
    if (normalized && !GENERIC_SPORT_SLUGS.has(normalized)) {
      return normalized;
    }
  }

  return null;
}

/**
 * Extract sport from Polymarket event/market using tagSlug as primary source.
 * Falls back to inferSportFromPolymarketTags when tagSlug is generic or missing.
 *
 * @param {object} params
 * @param {string | null | undefined} params.tagSlug - Primary sport slug from /sports endpoint
 * @param {string[]} params.tagSlugs - Array of tag slugs from event/market tags
 * @returns {{ sport: string | null, source: 'tagSlug' | 'inferred' | null }}
 */
export function extractSport({ tagSlug, tagSlugs }) {
  // Primary: use tagSlug from /sports endpoint
  if (tagSlug && !isGenericSlug(tagSlug)) {
    const sport = normalizePolymarketSportLabel(tagSlug);
    if (sport) {
      return { sport, source: "tagSlug" };
    }
  }

  // Fallback: infer from tags array
  const inferred = inferSportFromPolymarketTags(tagSlugs || []);
  if (inferred) {
    return { sport: inferred, source: "inferred" };
  }

  return { sport: null, source: null };
}

/**
 * Fetch sports events from Polymarket /sports endpoint.
 * Returns raw events with tagSlug populated from the endpoint response.
 *
 * @param {object} opts
 * @param {number} [opts.limit=100] - Max events to fetch
 * @param {number} [opts.offset=0] - Pagination offset
 * @returns {Promise<Array<{ event: object, tagSlug: string | null }>>}
 */
async function fetchSportsEvents({ limit = 100, offset = 0 } = {}) {
  const url = new URL(`${POLYMARKET_BASE}/sports`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  const data = await res.json();

  // Handle both array response and { events: [...] } response
  const events = Array.isArray(data)
    ? data
    : Array.isArray(data?.events)
      ? data.events
      : [];

  return events.map((ev) => ({
    event: ev,
    tagSlug: ev?.tagSlug ?? ev?.tag_slug ?? ev?.sport ?? null,
  }));
}

/**
 * Ingest Polymarket sports events.
 * Uses tagSlug from /sports endpoint as primary sport source.
 * Falls back to inferSportFromPolymarketTags when tagSlug is generic or missing.
 *
 * @param {object} opts
 * @param {number} [opts.maxEvents=100] - Maximum events to process
 * @param {boolean} [opts.dryRun=false] - If true, don't write to DB
 * @returns {Promise<{
 *   eventsVisited: number,
 *   sportFromTagSlug: number,
 *   sportFromInferred: number,
 *   sportUnknown: number,
 *   sportBreakdown: Record<string, number>
 * }>}
 */
export async function ingestPolymarketSports(opts = {}) {
  const { maxEvents = 100, dryRun = false } = opts;

  const report = {
    eventsVisited: 0,
    sportFromTagSlug: 0,
    sportFromInferred: 0,
    sportUnknown: 0,
    sportBreakdown: {},
  };

  let offset = 0;
  const limit = 50;

  while (report.eventsVisited < maxEvents) {
    const batch = await fetchSportsEvents({ limit, offset });
    if (batch.length === 0) break;

    for (const { event, tagSlug } of batch) {
      if (report.eventsVisited >= maxEvents) break;
      report.eventsVisited += 1;

      // Extract tag slugs from event.tags array
      const tags = Array.isArray(event?.tags) ? event.tags : [];
      const tagSlugs = tags
        .map((t) => String(t?.slug || t?.label || "").toLowerCase())
        .filter(Boolean);

      // Use extractSport which prioritizes tagSlug, falls back to tag inference
      const { sport, source } = extractSport({ tagSlug, tagSlugs });

      if (source === "tagSlug") {
        report.sportFromTagSlug += 1;
      } else if (source === "inferred") {
        report.sportFromInferred += 1;
      } else {
        report.sportUnknown += 1;
      }

      if (sport) {
        report.sportBreakdown[sport] = (report.sportBreakdown[sport] || 0) + 1;
      }

      // TODO: Phase E1.5 Part 2 will add actual DB ingestion here
      // For now, this validates the sport inference logic
      if (!dryRun) {
        // Placeholder for DB write - will be implemented in Part 2
      }
    }

    offset += batch.length;
    if (batch.length < limit) break;
  }

  return report;
}
