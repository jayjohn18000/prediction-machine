#!/usr/bin/env node
/**
 * PMCI: Discover Kalshi politics series tickers for PMCI_POLITICS_KALSHI_SERIES_TICKERS.
 *
 * Queries Kalshi metadata endpoints used in this repo:
 *   - GET /series (list all series; filter by category/title/tags for politics)
 *   - GET /events?series_ticker=X&limit=1 (verify series has events)
 *
 * Prints:
 *   - Likely politics series tickers (title, ticker, category, sample event count)
 *   - Copy-paste env line for PMCI_POLITICS_KALSHI_SERIES_TICKERS
 *
 * Usage: node scripts/pmci-discover:kalshi:politics
 * Env: PMCI_DISCOVER_DELAY_MS=200 (delay between series checks), PMCI_DISCOVER_MAX_SERIES=80 (cap so run finishes in ~1-2 min)
 */

const KALSHI_BASES = [
  'https://api.elections.kalshi.com/trade-api/v2',
  'https://api.kalshi.com/trade-api/v2',
];

// Keywords in title or tags that suggest politics/elections
const POLITICS_KEYWORDS = [
  'election', 'president', 'congress', 'senate', 'house', 'governor', 'nominee',
  'primary', 'vote', 'political', 'politics', 'government', 'shutdown', 'fed',
  'supreme court', 'impeachment', 'cabinet', 'nomination', 'democrat', 'republican',
  '2028', '2026', '2024', 'ballot', 'electoral',
];

function normalize(s) {
  return (s || '').toLowerCase().trim();
}

function isLikelyPolitics(series) {
  const title = normalize(series.title || '');
  const category = normalize(series.category || '');
  const tags = Array.isArray(series.tags) ? series.tags.map((t) => normalize(String(t))) : [];
  const combined = [title, category, ...tags].join(' ');
  return POLITICS_KEYWORDS.some((kw) => combined.includes(kw));
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {}
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || text.slice(0, 200);
    throw new Error(`HTTP ${res.status} for ${url}: ${msg}`);
  }
  return data;
}

async function getSeriesList(base) {
  const out = [];
  let cursor = null;
  do {
    const url = new URL(`${base}/series`);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const data = await fetchJson(url.toString());
    const chunk = Array.isArray(data?.series) ? data.series : [];
    out.push(...chunk);
    cursor = data?.cursor ?? null;
  } while (cursor);
  return out;
}

async function getEventCountForSeries(base, seriesTicker, delayMs = 200) {
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  const url = new URL(`${base}/events`);
  url.searchParams.set('series_ticker', seriesTicker);
  url.searchParams.set('limit', '1');
  const data = await fetchJson(url.toString());
  const events = Array.isArray(data?.events) ? data.events : [];
  return events.length;
}

async function main() {
  let base = null;
  for (const b of KALSHI_BASES) {
    try {
      const u = new URL(`${b}/series`);
      u.searchParams.set('limit', '1');
      await fetchJson(u.toString());
      base = b;
      break;
    } catch (_) {}
  }
  if (!base) {
    console.error('Could not reach any Kalshi API base');
    process.exit(1);
  }

  console.log('pmci:discover:kalshi:politics using base:', base);
  const allSeries = await getSeriesList(base);
  let politics = allSeries.filter(isLikelyPolitics);
  // Prefer Politics / Elections category so we verify the most relevant first
  const categoryRank = (s) => {
    const c = normalize(s.category || '');
    if (c === 'politics') return 0;
    if (c === 'elections') return 1;
    return 2;
  };
  politics.sort((a, b) => categoryRank(a) - categoryRank(b));

  const maxSeries = Math.max(1, Math.min(500, Number(process.env.PMCI_DISCOVER_MAX_SERIES || '80')));
  const toProcess = politics.slice(0, maxSeries);
  const capped = politics.length > maxSeries;

  console.log(`Likely politics series: ${politics.length} total; verifying first ${toProcess.length} (cap ${maxSeries}).`);
  console.log('---');
  const tickers = [];
  const delayMs = Number(process.env.PMCI_DISCOVER_DELAY_MS || '200');
  for (const s of toProcess) {
    const ticker = s.ticker || s.series_ticker;
    if (!ticker) continue;
    const eventCount = await getEventCountForSeries(base, ticker, delayMs);
    console.log(`  ${ticker}\t${(s.title || '').slice(0, 60)}\tcategory=${s.category || ''}\tevents_sample=${eventCount}`);
    tickers.push(ticker);
  }
  console.log('---');
  if (capped) console.log(`(Capped at ${maxSeries} series; set PMCI_DISCOVER_MAX_SERIES higher to verify more.)`);
  console.log(`Tickers collected: ${tickers.length}`);

  if (tickers.length > 0) {
    const envValue = tickers.join(',');
    console.log('\n--- Copy the line below into your .env file (project root) ---');
    console.log(`PMCI_POLITICS_KALSHI_SERIES_TICKERS="${envValue}"`);
    console.log('---');
  } else {
    console.log('\nNo politics series found. Try broadening POLITICS_KEYWORDS in this script or check Kalshi API response.');
  }
}

main().catch((err) => {
  console.error('pmci:discover:kalshi:politics FAIL:', err.message);
  process.exit(1);
});
