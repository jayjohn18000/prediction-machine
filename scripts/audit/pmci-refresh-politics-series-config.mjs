#!/usr/bin/env node
/**
 * Build a maintainable politics-series config from live Kalshi series metadata.
 * Writes:
 *  - config/pmci-politics-series.generated.json
 *  - config/pmci-politics-series.env
 *
 * Goal: replace opaque legacy ticker blobs with reviewable, derived config.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../../src/platform/env.mjs';

loadEnv();

const KALSHI_BASES = [
  'https://api.elections.kalshi.com/trade-api/v2',
  'https://api.kalshi.com/trade-api/v2',
];

const HIGH_VALUE_HINTS = [/senate/i, /governor/i, /president/i, /nominee/i, /house/i, /attorney general/i];
const KEY_PREFIXES = [/^SENATE/i, /^GOVPARTY/i, /^PRES/i, /^HOUSE/i, /^AG/i, /^KXGOV/i, /^KXSENATE/i, /^KXPRESNOM/i];

const MAX_SERIES = Math.max(50, Number(process.env.PMCI_DISCOVER_MAX_SERIES || 220));
const OUT_JSON = path.resolve(process.cwd(), 'config/pmci-politics-series.generated.json');
const OUT_ENV = path.resolve(process.cwd(), 'config/pmci-politics-series.env');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(s) {
  return String(s || '').toLowerCase();
}

function isPoliticsSeries(series) {
  const category = normalize(series?.category);
  const title = normalize(series?.title);
  const tags = Array.isArray(series?.tags) ? series.tags.map((t) => normalize(t)).join(' ') : '';
  const blob = `${title} ${category} ${tags}`;
  return category.includes('polit') || category.includes('election') ||
    /election|senate|governor|president|nominee|primary|house|congress|attorney general/.test(blob);
}

function isHighValue(series) {
  const ticker = String(series?.ticker || series?.series_ticker || '');
  const title = String(series?.title || '');
  return KEY_PREFIXES.some((re) => re.test(ticker)) || HIGH_VALUE_HINTS.some((re) => re.test(title));
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || text.slice(0, 160);
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return data;
}

async function chooseBase() {
  for (const base of KALSHI_BASES) {
    try {
      await fetchJson(`${base}/series?limit=1`);
      return base;
    } catch {}
  }
  throw new Error('Could not reach Kalshi /series endpoint on known bases.');
}

async function fetchSeries(base) {
  let cursor = null;
  const out = [];
  do {
    const u = new URL(`${base}/series`);
    u.searchParams.set('limit', '200');
    if (cursor) u.searchParams.set('cursor', cursor);
    const data = await fetchJson(u.toString());
    out.push(...(Array.isArray(data?.series) ? data.series : []));
    cursor = data?.cursor || null;
  } while (cursor && out.length < 6000);
  return out;
}

async function openEventCount(base, ticker) {
  const u = new URL(`${base}/events`);
  u.searchParams.set('series_ticker', ticker);
  u.searchParams.set('status', 'open');
  u.searchParams.set('limit', '1');
  const data = await fetchJson(u.toString());
  return Array.isArray(data?.events) ? data.events.length : 0;
}

function rankSeries(a, b) {
  const ah = a.highValue ? 1 : 0;
  const bh = b.highValue ? 1 : 0;
  if (ah !== bh) return bh - ah;
  if (a.openEvents !== b.openEvents) return b.openEvents - a.openEvents;
  return String(a.ticker).localeCompare(String(b.ticker));
}

async function main() {
  const base = await chooseBase();
  const all = await fetchSeries(base);

  const candidates = all
    .filter((s) => isPoliticsSeries(s))
    .map((s) => ({
      ticker: s.ticker || s.series_ticker,
      title: s.title || '',
      category: s.category || '',
      tags: Array.isArray(s.tags) ? s.tags : [],
      highValue: isHighValue(s),
      openEvents: 0,
    }))
    .filter((s) => !!s.ticker)
    .slice(0, MAX_SERIES);

  const delayMs = Number(process.env.PMCI_DISCOVER_DELAY_MS || 160);
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    try {
      c.openEvents = await openEventCount(base, c.ticker);
    } catch {
      c.openEvents = 0;
    }
    if ((i + 1) % 50 === 0) {
      console.error(`checked ${i + 1}/${candidates.length}`);
    }
    await sleep(delayMs);
  }

  const live = candidates.filter((c) => c.openEvents > 0).sort(rankSeries);
  const selected = live.map((c) => c.ticker);

  const payload = {
    generatedAt: new Date().toISOString(),
    source: {
      endpoint: `${base}/series + ${base}/events?status=open&limit=1`,
      maxSeriesScanned: MAX_SERIES,
    },
    summary: {
      politicsCandidates: candidates.length,
      liveCandidates: live.length,
      selectedTickers: selected.length,
      highValueLive: live.filter((x) => x.highValue).length,
    },
    selectedTickers: selected,
    liveSeries: live,
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const envLine = `PMCI_POLITICS_KALSHI_SERIES_TICKERS="${selected.join(',')}"`;
  fs.writeFileSync(
    OUT_ENV,
    [
      '# Auto-generated by scripts/audit/pmci-refresh-politics-series-config.mjs',
      `# generated_at=${payload.generatedAt}`,
      envLine,
      '',
    ].join('\n'),
    'utf8',
  );

  console.log(`Wrote ${OUT_JSON}`);
  console.log(`Wrote ${OUT_ENV}`);
  console.log(`Live/selected tickers: ${selected.length}`);
  console.log(envLine);
}

main().catch((err) => {
  console.error('pmci:refresh:series-config FAIL:', err.message);
  process.exit(1);
});
