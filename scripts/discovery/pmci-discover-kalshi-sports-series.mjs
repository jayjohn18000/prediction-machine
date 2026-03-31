import { retry, fetchWithTimeout } from "../../lib/retry.mjs";

const KALSHI_BASES = [
  "https://api.elections.kalshi.com/trade-api/v2",
  "https://trading-api.kalshi.com/trade-api/v2",
];

let kalshiBase = null;

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

function toSeriesFromMarkets(markets) {
  const bySeries = new Map();

  for (const m of markets) {
    const seriesTicker = m?.series_ticker || m?.seriesTicker;
    const seriesTitle = m?.series_title || m?.seriesTitle || m?.title || "(untitled)";
    const marketTicker = m?.ticker || "";
    const category = m?.category || m?.category_name || "";

    const sportsHit =
      isSportsText(seriesTicker) ||
      isSportsText(seriesTitle) ||
      isSportsText(marketTicker) ||
      isSportsText(category);

    if (!sportsHit || !seriesTicker) continue;

    if (!bySeries.has(seriesTicker)) {
      bySeries.set(seriesTicker, {
        seriesTicker,
        seriesTitle,
        marketCount: 0,
      });
    }
    bySeries.get(seriesTicker).marketCount += 1;
  }

  return [...bySeries.values()].sort((a, b) => b.marketCount - a.marketCount || a.seriesTicker.localeCompare(b.seriesTicker));
}

async function fetchKalshiJson(base, path) {
  const url = `${base}${path}`;
  const res = await retry(
    () => fetchWithTimeout(url, {}, 15_000),
    { maxAttempts: 2, baseDelayMs: 800 }
  );
  if (!res.ok) {
    console.error(`Kalshi HTTP ${res.status} for ${path}`);
    return { ok: false, data: null };
  }
  try {
    const data = await res.json();
    return { ok: true, data };
  } catch {
    return { ok: false, data: null };
  }
}

async function discoverKalshiSportsSeries() {
  for (const base of KALSHI_BASES) {
    // Strategy 1: query /events endpoint — events have titles we can filter
    const eventsResult = await fetchKalshiJson(base, "/events?limit=200&status=open");
    if (eventsResult.ok) {
      kalshiBase = base;
      const events = Array.isArray(eventsResult.data?.events) ? eventsResult.data.events : [];
      const sportsEvents = events.filter((ev) =>
        isSportsText(ev?.title || "") ||
        isSportsText(ev?.category || "") ||
        isSportsText(ev?.event_ticker || "")
      );

      // Also try series endpoint
      const seriesResult = await fetchKalshiJson(base, "/series?limit=200");
      const allSeries = Array.isArray(seriesResult.data?.series) ? seriesResult.data.series : [];
      const sportsSeries = allSeries.filter((s) =>
        isSportsText(s?.title || "") || isSportsText(s?.ticker || "")
      );

      // Strategy 2 fallback: scan markets if events returned nothing
      if (sportsEvents.length === 0 && sportsSeries.length === 0) {
        const marketsResult = await fetchKalshiJson(base, "/markets?limit=1000");
        if (marketsResult.ok) {
          const markets = Array.isArray(marketsResult.data?.markets) ? marketsResult.data.markets : [];
          return { base, series: toSeriesFromMarkets(markets), eventCount: 0, totalEvents: events.length };
        }
      }

      // Build series from events
      const bySeriesTicker = new Map();
      for (const ev of sportsEvents) {
        const ticker = ev?.event_ticker || ev?.ticker || "(unknown)";
        const title = ev?.title || "(untitled)";
        const markets = Array.isArray(ev?.markets) ? ev.markets : [];
        if (!bySeriesTicker.has(ticker)) {
          bySeriesTicker.set(ticker, { seriesTicker: ticker, seriesTitle: title, marketCount: markets.length || 1 });
        } else {
          bySeriesTicker.get(ticker).marketCount += markets.length || 1;
        }
      }
      for (const s of sportsSeries) {
        const ticker = s?.ticker || "(unknown)";
        if (!bySeriesTicker.has(ticker)) {
          bySeriesTicker.set(ticker, { seriesTicker: ticker, seriesTitle: s?.title || "(untitled)", marketCount: 0 });
        }
      }

      const series = [...bySeriesTicker.values()].sort((a, b) => b.marketCount - a.marketCount);
      return { base, series, eventCount: sportsEvents.length, totalEvents: events.length };
    }
  }

  return { base: null, series: [], eventCount: 0, totalEvents: 0 };
}

function printDiscoveries(base, series) {
  console.log("KALSHI_SPORTS_DISCOVERY");
  console.log(`endpoint=${base || "unresolved"}`);
  console.log(`series_count=${series.length}`);
  console.log("series_title | series_ticker | market_count");

  for (const s of series) {
    console.log(`${s.seriesTitle} | ${s.seriesTicker} | ${s.marketCount}`);
  }
}

const { base, series, eventCount, totalEvents } = await discoverKalshiSportsSeries();
if (totalEvents != null) {
  console.log(`total_events_returned=${totalEvents}`);
  console.log(`sports_events_matched=${eventCount}`);
}
printDiscoveries(base, series);

console.log("\nPROPOSED_ENV_STDOUT_ONLY");
console.log(`PMCI_SPORTS_KALSHI_SERIES_TICKERS=${series.map((s) => s.seriesTicker).join(",")}`);
