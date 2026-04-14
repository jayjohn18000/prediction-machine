#!/usr/bin/env node
/**
 * Competitive coverage benchmark: PMCI (DATABASE_URL) vs SimpleFunctions (public)
 * and optionally Oddpool (ODDPOOL_API_KEY + X-API-Key header).
 *
 * Does not write secrets. Writes aggregates under output/benchmark/.
 *
 * Usage: npm run pmci:benchmark:coverage
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(ROOT, "output", "benchmark");

const SF_BASE = "https://simplefunctions.dev";
const ODDPOOL_BASE = "https://api.oddpool.com";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _parseError: true, status: res.status, snippet: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, body };
}

async function runPmciQueries(client) {
  const queries = {
    category_distribution: `SELECT category, count(*)::int AS cnt FROM pmci.provider_markets GROUP BY category ORDER BY cnt DESC`,
    provider_distribution: `SELECT p.code, count(*)::int AS cnt FROM pmci.provider_markets pm JOIN pmci.providers p ON p.id = pm.provider_id GROUP BY p.code`,
    rejection_top: `SELECT reasons->>'proposal_type' AS type, reasons->>'reject_reason' AS reason, count(*)::int AS cnt FROM pmci.proposed_links WHERE decision = 'rejected' GROUP BY 1, 2 ORDER BY cnt DESC NULLS LAST LIMIT 30`,
    rejected_confidence_buckets: `SELECT CASE WHEN confidence < 0.1 THEN '0.0-0.1' WHEN confidence < 0.2 THEN '0.1-0.2' WHEN confidence < 0.3 THEN '0.2-0.3' WHEN confidence < 0.4 THEN '0.3-0.4' WHEN confidence < 0.5 THEN '0.4-0.5' WHEN confidence < 0.6 THEN '0.5-0.6' WHEN confidence < 0.7 THEN '0.6-0.7' WHEN confidence < 0.8 THEN '0.7-0.8' WHEN confidence < 0.9 THEN '0.8-0.9' ELSE '0.9-1.0' END AS bucket, count(*)::int AS cnt FROM pmci.proposed_links WHERE decision = 'rejected' GROUP BY 1 ORDER BY 1`,
    link_rate_by_category: `SELECT pm.category, count(DISTINCT pm.id)::int AS total_markets, count(DISTINCT ml.provider_market_id)::int AS linked_markets FROM pmci.provider_markets pm LEFT JOIN pmci.market_links ml ON ml.provider_market_id = pm.id AND ml.status = 'active' GROUP BY pm.category ORDER BY total_markets DESC`,
    provider_category: `SELECT p.code AS provider, pm.category, count(*)::int AS cnt FROM pmci.provider_markets pm JOIN pmci.providers p ON p.id = pm.provider_id GROUP BY p.code, pm.category ORDER BY p.code, cnt DESC`,
    kalshi_series_top: `SELECT split_part(provider_market_ref, '-', 1) AS series_prefix, count(*)::int AS cnt FROM pmci.provider_markets WHERE provider_id = 1 GROUP BY series_prefix ORDER BY cnt DESC LIMIT 50`,
    proposal_decisions: `SELECT decision, count(*)::int AS cnt FROM pmci.proposed_links GROUP BY decision ORDER BY cnt DESC`,
    accepted_by_category: `SELECT category, count(*)::int AS cnt FROM pmci.proposed_links WHERE decision = 'accepted' GROUP BY category ORDER BY cnt DESC`,
    family_link_coverage: `SELECT CASE WHEN link_count > 0 THEN 'has_links' ELSE 'no_links' END AS status, count(*)::int AS cnt FROM (SELECT mf.id, count(ml.id)::int AS link_count FROM pmci.market_families mf LEFT JOIN pmci.market_links ml ON ml.family_id = mf.id AND ml.status = 'active' GROUP BY mf.id) sub GROUP BY 1`,
    sports_by_sport: `SELECT sport, count(*)::int AS cnt FROM pmci.provider_markets WHERE category = 'sports' GROUP BY sport ORDER BY cnt DESC NULLS LAST LIMIT 30`,
    poly_slugs_sample: `SELECT DISTINCT split_part(provider_market_ref, '#', 1) AS slug FROM pmci.provider_markets WHERE provider_id = 2 ORDER BY slug LIMIT 100`,
    v_current_links: `SELECT count(*)::int AS current_links FROM pmci.v_market_links_current`,
    families_total: `SELECT count(*)::int AS families FROM pmci.market_families`,
    rejected_reason_keys: `SELECT k, count(*)::int AS cnt FROM pmci.proposed_links p, LATERAL jsonb_object_keys(COALESCE(p.reasons, '{}'::jsonb)) AS k WHERE p.decision = 'rejected' GROUP BY k ORDER BY cnt DESC LIMIT 40`,
    sports_skip_reasons: `SELECT reasons->>'skip_reason' AS skip_reason, count(*)::int AS cnt FROM pmci.proposed_links WHERE decision = 'rejected' AND category = 'sports' GROUP BY 1 ORDER BY cnt DESC NULLS LAST LIMIT 25`,
    observer_latest: `SELECT cycle_at, pairs_configured, pairs_attempted, pairs_succeeded FROM pmci.observer_heartbeats ORDER BY cycle_at DESC LIMIT 1`,
  };

  const out = {};
  for (const [k, sql] of Object.entries(queries)) {
    const { rows } = await client.query(sql);
    out[k] = rows;
  }
  return out;
}

function summarizeSfScreen(body) {
  if (!body || typeof body !== "object") return null;
  return {
    totalUniverse: body.totalUniverse ?? null,
    totalAfterFilter: body.totalAfterFilter ?? null,
    count: body.count ?? null,
    filters: body.filters ?? null,
    venueMix: Array.isArray(body.markets)
      ? body.markets.reduce((acc, m) => {
          acc[m.venue] = (acc[m.venue] || 0) + 1;
          return acc;
        }, {})
      : null,
    kalshiCategoriesInTop: Array.isArray(body.markets)
      ? body.markets.filter((m) => m.venue === "kalshi").map((m) => m.category).filter(Boolean)
      : [],
  };
}

async function fetchOddpoolSearch(q, limit, apiKey) {
  const u = new URL(`${ODDPOOL_BASE}/search/events`);
  u.searchParams.set("q", q);
  u.searchParams.set("sort_by", "volume");
  u.searchParams.set("limit", String(limit));
  const res = await fetch(u, { headers: { "X-API-Key": apiKey } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text.slice(0, 300) };
  }
  return { ok: res.ok, status: res.status, body };
}

function summarizeOddpoolEvents(body) {
  if (!Array.isArray(body)) {
    return { error: typeof body === "object" ? body.detail || body : "not_array", count: 0 };
  }
  let kalshi = 0;
  let polymarket = 0;
  let markets = 0;
  const samples = [];
  for (const e of body) {
    const ex = String(e.exchange || "").toLowerCase();
    if (ex === "kalshi") kalshi += 1;
    if (ex === "polymarket") polymarket += 1;
    markets += Number(e.market_count || 0) || 0;
    if (samples.length < 5) samples.push({ event_id: e.event_id, exchange: e.exchange, title: e.title, market_count: e.market_count });
  }
  return { count: body.length, kalshi, polymarket, market_count_sum: markets, samples };
}

async function main() {
  ensureDir(OUT);
  const ts = new Date().toISOString();
  const report = { generated_at: ts, pmci: null, simplefunctions: null, oddpool: null, event_pairs_count: null };

  const pairsPath = path.join(ROOT, "event_pairs.json");
  if (fs.existsSync(pairsPath)) {
    const pairs = JSON.parse(fs.readFileSync(pairsPath, "utf8"));
    report.event_pairs_count = Array.isArray(pairs) ? pairs.length : null;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    report.pmci = { error: "DATABASE_URL not set; skipping PMCI SQL" };
  } else {
    const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      report.pmci = await runPmciQueries(client);
    } finally {
      await client.end();
    }
  }

  const sfUrls = [
    ["screen_all", `${SF_BASE}/api/public/screen?limit=100&sort=volume&excludeSports=false`],
    ["screen_politics", `${SF_BASE}/api/public/screen?limit=100&sort=volume&category=politics`],
    ["screen_crypto", `${SF_BASE}/api/public/screen?limit=100&sort=volume&category=crypto`],
    ["screen_economics", `${SF_BASE}/api/public/screen?limit=100&sort=volume&category=economics`],
    ["screen_sports", `${SF_BASE}/api/public/screen?limit=100&sort=volume&category=sports&excludeSports=false`],
    ["screen_kalshi", `${SF_BASE}/api/public/screen?limit=100&sort=volume&venue=kalshi`],
    ["screen_polymarket", `${SF_BASE}/api/public/screen?limit=100&sort=volume&venue=polymarket`],
    ["diff_iran", `${SF_BASE}/api/public/diff?topic=iran`],
    ["contagion", `${SF_BASE}/api/public/contagion?window=24h`],
    ["newmarkets", `${SF_BASE}/api/public/newmarkets?limit=50`],
    ["ideas", `${SF_BASE}/api/public/ideas`],
  ];

  report.simplefunctions = {};
  for (const [name, url] of sfUrls) {
    const r = await fetchJson(url);
    report.simplefunctions[name] = {
      ok: r.ok,
      status: r.status,
      summary: name.startsWith("screen_") ? summarizeSfScreen(r.body) : { keys: r.body && typeof r.body === "object" ? Object.keys(r.body).slice(0, 12) : [] },
    };
    if (name === "diff_iran" && r.body && typeof r.body === "object" && Array.isArray(r.body.tickers)) {
      report.simplefunctions[name].tickerCount = r.body.tickers.length;
    }
    if (name === "contagion" && r.body && typeof r.body === "object") {
      const g = r.body.gaps ?? r.body.contagion ?? r.body.items;
      if (Array.isArray(g)) report.simplefunctions[name].gapCount = g.length;
    }
  }

  const oddKey = process.env.ODDPOOL_API_KEY;
  if (!oddKey) {
    report.oddpool = { skipped: true, message: "Set ODDPOOL_API_KEY in .env to sample Oddpool (do not commit keys)." };
  } else {
    report.oddpool = { queries: {} };
    const queries = [
      ["president", "president", 100],
      ["bitcoin", "bitcoin", 50],
      ["nba", "nba", 50],
      ["fed_rate", "fed+rate", 50],
      ["governor", "governor", 50],
      ["senate", "senate", 50],
      ["recent", "", 0],
    ];
    for (const [key, q, limit] of queries) {
      if (key === "recent") {
        const u = `${ODDPOOL_BASE}/search/recent/events?limit=50`;
        const res = await fetch(u, { headers: { "X-API-Key": oddKey } });
        const text = await res.text();
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = { _raw: text.slice(0, 200) };
        }
        report.oddpool.queries.recent = { ok: res.ok, status: res.status, summary: summarizeOddpoolEvents(body) };
      } else {
        const r = await fetchOddpoolSearch(q, limit, oddKey);
        report.oddpool.queries[key] = { ok: r.ok, status: r.status, summary: summarizeOddpoolEvents(r.body) };
      }
      await sleep(3000);
    }
  }

  const outJson = path.join(OUT, "last-run.json");
  fs.writeFileSync(outJson, JSON.stringify(report, null, 2), "utf8");

  // Human-readable one-pager to stdout
  console.log("=== PMCI benchmark (coverage-benchmark.mjs) ===\n");
  console.log(`Written: ${outJson}\n`);
  if (report.pmci && !report.pmci.error) {
    console.log("PMCI category_distribution:", JSON.stringify(report.pmci.category_distribution, null, 2));
    console.log("PMCI provider_distribution:", JSON.stringify(report.pmci.provider_distribution, null, 2));
    console.log("PMCI v_current_links / families:", report.pmci.v_current_links?.[0], report.pmci.families_total?.[0]);
    console.log("PMCI proposal_decisions:", JSON.stringify(report.pmci.proposal_decisions, null, 2));
    console.log("PMCI link_rate_by_category:", JSON.stringify(report.pmci.link_rate_by_category, null, 2));
    console.log("PMCI rejection_top (first 10):", JSON.stringify(report.pmci.rejection_top?.slice(0, 10), null, 2));
    console.log("PMCI sports_skip_reasons:", JSON.stringify(report.pmci.sports_skip_reasons, null, 2));
    console.log("PMCI rejected_confidence_buckets:", JSON.stringify(report.pmci.rejected_confidence_buckets, null, 2));
  } else {
    console.log("PMCI:", report.pmci?.error || report.pmci);
  }
  console.log("\nSimpleFunctions screen_all:", JSON.stringify(report.simplefunctions.screen_all, null, 2));
  console.log("\nOddpool:", JSON.stringify(report.oddpool, null, 2));
  console.log(`\nevent_pairs.json entries: ${report.event_pairs_count ?? "n/a"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
