import { retry, fetchWithTimeout } from "../../lib/retry.mjs";

const POLYMARKET_BASES = ["https://gamma-api.polymarket.com"];
let polymarketBase = null;

const SPORTS_PATTERNS = [
  /\bnfl\b/i,
  /\bnba\b/i,
  /\bmlb\b/i,
  /\bnhl\b/i,
  /\bsoccer\b/i,
  /\bfootball\b/i,
  /\bbasketball\b/i,
  /\bbaseball\b/i,
  /\bhockey\b/i,
  /\bchampions league\b/i,
  /\bpremier league\b/i,
  /\bfa cup\b/i,
  /\bworld cup\b/i,
  /\beuropa\b/i,
  /\bmls\b/i,
  /\bla liga\b/i,
  /\bserie a\b/i,
  /\bbundesliga\b/i,
  /\bligue 1\b/i,
];

function isSportsText(v) {
  if (!v || typeof v !== "string") return false;
  return SPORTS_PATTERNS.some((re) => re.test(v));
}

async function fetchJson(base, path) {
  const url = `${base}${path}`;
  const res = await retry(
    () => fetchWithTimeout(url, {}, 10_000),
    { maxAttempts: 2, baseDelayMs: 800 }
  );
  if (!res.ok) {
    console.error(`Polymarket HTTP ${res.status} for ${path}`);
    return null;
  }
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function resolvePolymarketBase() {
  if (polymarketBase) return polymarketBase;
  for (const base of POLYMARKET_BASES) {
    const tags = await fetchJson(base, "/tags");
    if (Array.isArray(tags)) {
      polymarketBase = base;
      return base;
    }
  }
  return null;
}

function normalizeTag(tag) {
  return {
    tagId: String(tag?.id ?? tag?.tag_id ?? ""),
    name: String(tag?.label ?? tag?.name ?? ""),
  };
}

function likelyLeague(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("nfl") || n.includes("football")) return "NFL";
  if (n.includes("nba") || n.includes("basketball")) return "NBA";
  if (n.includes("mlb") || n.includes("baseball")) return "MLB";
  if (n.includes("nhl") || n.includes("hockey")) return "NHL";
  if (n.includes("soccer") || n.includes("premier") || n.includes("champions") || n.includes("la liga") || n.includes("serie a") || n.includes("bundesliga") || n.includes("ligue 1") || n.includes("mls")) return "SOCCER";
  return "UNKNOWN";
}

async function discoverPolymarketSportsTags() {
  const base = await resolvePolymarketBase();
  if (!base) return { base: null, tags: [] };

  const rawTags = await fetchJson(base, "/tags");
  const tags = Array.isArray(rawTags) ? rawTags.map(normalizeTag) : [];

  const sportsTags = tags
    .filter((t) => t.tagId && t.name && isSportsText(t.name))
    .map((t) => ({ ...t, marketCount: 0, leagueHint: likelyLeague(t.name) }));

  const events = await fetchJson(base, "/events?active=true&closed=false&limit=1000");
  const eventList = Array.isArray(events) ? events : [];

  const byId = new Map(sportsTags.map((t) => [t.tagId, t]));

  // Pass 1: tag-based counting (original logic)
  for (const ev of eventList) {
    const eventTags = Array.isArray(ev?.tags) ? ev.tags : [];
    const markets = Array.isArray(ev?.markets) ? ev.markets : [];
    for (const tag of eventTags) {
      const tid = String(tag?.id ?? tag?.tag_id ?? "");
      if (!byId.has(tid)) continue;
      byId.get(tid).marketCount += markets.length || 1;
    }
  }

  // Pass 2: keyword-based event title scan — picks up active sports events
  // whose tag IDs were not in the initial tag list (e.g. current NBA season, March Madness)
  const keywordEvents = eventList.filter((ev) => {
    const title = ev?.title || ev?.question || "";
    const desc = ev?.description || "";
    return isSportsText(title) || isSportsText(desc);
  });

  // Extract all unique tag IDs from keyword-matched events and add as synthetic tags
  const syntheticById = new Map();
  for (const ev of keywordEvents) {
    const evTags = Array.isArray(ev?.tags) ? ev.tags : [];
    const markets = Array.isArray(ev?.markets) ? ev.markets : [];
    for (const tag of evTags) {
      const tid = String(tag?.id ?? tag?.tag_id ?? "");
      const tname = String(tag?.label ?? tag?.name ?? "");
      if (!tid || byId.has(tid)) continue; // skip already known tags
      if (!syntheticById.has(tid)) {
        syntheticById.set(tid, {
          tagId: tid,
          name: tname || `tag:${tid}`,
          marketCount: 0,
          leagueHint: likelyLeague(tname),
        });
      }
      syntheticById.get(tid).marketCount += markets.length || 1;
    }
    // If event has no tags at all, create a synthetic entry from its title
    if (evTags.length === 0) {
      const title = ev?.title || ev?.question || "";
      const synId = `keyword:${title.slice(0, 40).replace(/\s+/g, "_")}`;
      if (!syntheticById.has(synId)) {
        syntheticById.set(synId, {
          tagId: synId,
          name: title.slice(0, 60),
          marketCount: 0,
          leagueHint: likelyLeague(title),
        });
      }
      syntheticById.get(synId).marketCount += 1;
    }
  }

  // Merge synthetic tags into the discovered set
  for (const [tid, tag] of syntheticById) {
    byId.set(tid, tag);
  }

  const discovered = [...byId.values()].sort((a, b) => b.marketCount - a.marketCount || a.name.localeCompare(b.name));
  return { base, tags: discovered, keywordEventCount: keywordEvents.length };
}

async function discoverKalshiSportsSeries() {
  const bases = [
    "https://api.elections.kalshi.com/trade-api/v2",
    "https://trading-api.kalshi.com/trade-api/v2",
  ];

  for (const base of bases) {
    const res = await retry(
      () => fetchWithTimeout(`${base}/markets?limit=1000`, {}, 15_000),
      { maxAttempts: 2, baseDelayMs: 800 }
    );
    if (!res.ok) continue;
    try {
      const data = await res.json();
      const markets = Array.isArray(data?.markets) ? data.markets : [];
      const series = new Map();
      for (const m of markets) {
        const ticker = m?.series_ticker || m?.seriesTicker;
        const title = m?.series_title || m?.seriesTitle || "";
        if (!ticker || !(isSportsText(ticker) || isSportsText(title) || isSportsText(m?.ticker) || isSportsText(m?.title))) continue;
        if (!series.has(ticker)) series.set(ticker, { ticker, title });
      }
      return [...series.values()];
    } catch {
      // continue
    }
  }
  return [];
}

function crossReference(tags, kalshiSeries) {
  const kalshiText = kalshiSeries.map((s) => `${s.ticker} ${s.title}`.toLowerCase());
  for (const t of tags) {
    const n = t.name.toLowerCase();
    const direct = kalshiText.filter((k) => k.includes(n) || n.includes(k)).length;
    const league = t.leagueHint;
    const leagueMatches = league === "UNKNOWN"
      ? 0
      : kalshiText.filter((k) => k.includes(league.toLowerCase())).length;
    t.crossPlatformLikely = direct > 0 || leagueMatches > 0;
    t.crossPlatformSignals = `direct=${direct};league=${leagueMatches}`;
  }
  return tags;
}

const { base, tags, keywordEventCount } = await discoverPolymarketSportsTags();
const kalshiSeries = await discoverKalshiSportsSeries();
const cross = crossReference(tags, kalshiSeries);

console.log("POLYMARKET_SPORTS_DISCOVERY");
console.log(`endpoint=${base || "unresolved"}`);
console.log(`tag_count=${cross.length}`);
console.log(`keyword_events_found=${keywordEventCount ?? 0}`);
console.log("tag_id | tag_name | market_count | likely_league | cross_platform_likely | signals");
for (const t of cross) {
  console.log(`${t.tagId} | ${t.name} | ${t.marketCount} | ${t.leagueHint} | ${t.crossPlatformLikely} | ${t.crossPlatformSignals}`);
}

const likelyBoth = cross.filter((t) => t.crossPlatformLikely);
console.log("\nLIKELY_BOTH_PLATFORM_EVENTS");
console.log(`count=${likelyBoth.length}`);
for (const t of likelyBoth) {
  console.log(`${t.tagId} | ${t.name} | ${t.marketCount}`);
}

console.log("\nPROPOSED_ENV_STDOUT_ONLY");
console.log(`PMCI_SPORTS_POLY_TAG_IDS=${cross.map((t) => t.tagId).join(",")}`);
