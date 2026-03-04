import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { query, getDbMetrics } from "./db.mjs";
import { SQL } from "./queries.mjs";
import { createPmciClient } from "../lib/pmci-ingestion.mjs";

const app = Fastify({ logger: true });
const MAX_LAG_SECONDS = Number(process.env.PMCI_MAX_LAG_SECONDS ?? "120");
const INGESTION_SUCCESS_TARGET = Number(process.env.PMCI_INGESTION_SUCCESS_TARGET ?? "0.99");
const API_P95_TARGET_MS = Number(process.env.PMCI_API_P95_TARGET_MS ?? "500");

const requestMetrics = {
  startedAt: new Date().toISOString(),
  total: 0,
  errors: 0,
  latenciesMs: [],
};

function recordLatency(ms) {
  requestMetrics.latenciesMs.push(ms);
  if (requestMetrics.latenciesMs.length > 5000) requestMetrics.latenciesMs.shift();
}

const RATE_LIMIT_CONFIG = {
  max: Number(process.env.PMCI_RATE_LIMIT_MAX ?? "60"),
  timeWindow: Number(process.env.PMCI_RATE_LIMIT_WINDOW_MS ?? "60000"),
  keyGenerator: (req) => req.headers["x-pmci-api-key"] ?? req.ip,
  errorResponseBuilder: () => ({
    error: "rate_limited",
    message: "Too many requests. See max and timeWindow in response headers.",
  }),
};

const PMCI_API_VERSION = "2026-03-02";

let logClient = null;
try {
  logClient = createPmciClient();
  if (logClient) {
    await logClient.connect();
  }
} catch (_) {
  logClient = null;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function typeFactor(rel) {
  switch (rel) {
    case "identical":
    case "equivalent":
      return 1.0;
    case "proxy":
      return 0.5;
    case "correlated":
      return 0.25;
    default:
      return 0.25;
  }
}

function computeConsensus(links, latestByMarketId) {
  let num = 0;
  let den = 0;

  for (const l of links) {
    if (l.status !== "active") continue;
    const snap = latestByMarketId.get(l.provider_market_id);
    if (!snap || snap.price_yes == null) continue;

    const liquidity = snap.liquidity == null ? 1 : Number(snap.liquidity);
    const confidence = Number(l.confidence);
    const w = liquidity * confidence * typeFactor(l.relationship_type);

    num += w * Number(snap.price_yes);
    den += w;
  }

  return den <= 0 ? null : (num / den);
}

function computeDivergence(price, consensus) {
  if (price == null || consensus == null) return null;
  return Math.abs(Number(price) - Number(consensus));
}

/** Parse since query: ISO date string or relative e.g. "24h", "7d". Returns Date or null. */
function parseSince(s) {
  if (!s || typeof s !== "string") return null;
  const trimmed = s.trim();
  const rel = trimmed.match(/^(\d+)(h|d)$/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const d = new Date();
    if (unit === "h") d.setHours(d.getHours() - n);
    else d.setDate(d.getDate() - n);
    return d;
  }
  const t = new Date(trimmed);
  return Number.isNaN(t.getTime()) ? null : t;
}

async function assertFreshness(req, reply) {
  try {
    const { rows } = await query(
      `select extract(epoch from (now() - max(observed_at)))::int as lag_seconds
       from pmci.provider_market_snapshots`
    );
    const lag = rows[0]?.lag_seconds != null ? Number(rows[0].lag_seconds) : null;
    if (lag == null || lag > MAX_LAG_SECONDS) {
      reply.code(503);
      return reply.send({
        error: "stale_data", lag_seconds: lag,
        max_lag_seconds: MAX_LAG_SECONDS,
        message: `Data is stale (${lag}s ago, max ${MAX_LAG_SECONDS}s). Observer may be down.`,
      });
    }
  } catch (err) {
    reply.code(503);
    return reply.send({ error: "freshness_check_failed", message: err.message });
  }
}

await app.register(rateLimit, {
  global: false,
});

app.addHook("onResponse", async (req, reply) => {
  const started = req.raw._pmciStartMs ?? Date.now();
  const latency = Date.now() - started;
  requestMetrics.total += 1;
  if (reply.statusCode >= 500) requestMetrics.errors += 1;
  recordLatency(latency);
  if (logClient) {
    const provided = req.headers["x-pmci-api-key"];
    const hint = provided ? String(provided).slice(-4) : null;
    const path = req.url.split("?")[0];
    logClient
      .query(
        `INSERT INTO pmci.request_log (method, path, status, latency_ms, api_key_hint)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.method, path, reply.statusCode, latency, hint],
      )
      .catch(() => {});
  }
});

app.addHook("onRequest", async (req) => {
  req.raw._pmciStartMs = Date.now();
});

app.addHook("onRequest", async (req, reply) => {
  const apiKey = process.env.PMCI_API_KEY;
  if (!apiKey) return;
  // Health routes remain public
  if (req.url.startsWith("/v1/health/")) return;
  const provided = req.headers["x-pmci-api-key"];
  if (provided !== apiKey) {
    reply.code(401);
    return reply.send({ error: "unauthorized" });
  }
});

app.addHook("onSend", async (req, reply) => {
  reply.header("X-PMCI-Version", PMCI_API_VERSION);
});

app.get("/v1/providers", { rateLimit: RATE_LIMIT_CONFIG }, async () => {
  const { rows } = await query(SQL.providers);
  return rows.map(r => ({ code: r.code, name: r.name }));
});

app.get("/v1/canonical-events", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
  const schema = z.object({ category: z.string().optional() });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return { error: parsed.error.flatten() };
  const { rows } = await query(SQL.canonical_events, [parsed.data.category ?? null]);
  return rows;
});

app.get("/v1/coverage", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
  const schema = z.object({
    provider: z.string().min(1),
    category: z.string().min(1).optional(),
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return { error: parsed.error.flatten() };

  const provRes = await query("select id from pmci.providers where code = $1", [parsed.data.provider]);
  if (provRes.rowCount === 0) return { error: "unknown_provider" };
  const providerId = provRes.rows[0].id;

  const category = parsed.data.category ?? null;
  const cov = await query(SQL.coverage, [providerId, category]);
  const row = cov.rows[0];

  return {
    provider: parsed.data.provider,
    category,
    total_markets: Number(row.total_markets),
    matched_markets: Number(row.matched_markets),
    coverage_ratio: Number(row.coverage_ratio),
    unmatched_breakdown: row.unmatched_breakdown ?? [],
  };
});

app.get("/v1/coverage/summary", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
  const schema = z.object({
    provider: z.string().min(1),
    category: z.string().min(1).optional(),
    since: z.string().optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return { error: parsed.error.flatten() };

  const provRes = await query("select id from pmci.providers where code = $1", [parsed.data.provider]);
  if (provRes.rowCount === 0) return { error: "unknown_provider" };
  const providerId = provRes.rows[0].id;

  const category = parsed.data.category ?? null;
  const sinceDate = parseSince(parsed.data.since);
  const sinceTs = sinceDate ? sinceDate.toISOString() : null;

  const { rows } = await query(SQL.coverage_summary, [providerId, category, sinceTs]);
  const row = rows[0];

  return {
    provider: parsed.data.provider,
    category: category ?? undefined,
    since: parsed.data.since ?? undefined,
    total_markets: Number(row.total_markets),
    linked_markets: Number(row.linked_markets),
    unlinked_markets: Number(row.unlinked_markets),
    coverage_ratio: Number(row.coverage_ratio),
  };
});

app.get("/v1/markets/unlinked", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
  const schema = z.object({
    provider: z.string().min(1),
    category: z.string().min(1).optional(),
    since: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return { error: parsed.error.flatten() };

  const provRes = await query("select id from pmci.providers where code = $1", [parsed.data.provider]);
  if (provRes.rowCount === 0) return { error: "unknown_provider" };
  const providerId = provRes.rows[0].id;

  const category = parsed.data.category ?? null;
  const sinceDate = parseSince(parsed.data.since);
  const sinceTs = sinceDate ? sinceDate.toISOString() : null;

  const { rows } = await query(SQL.unlinked_markets, [providerId, category, sinceTs, parsed.data.limit]);

  return rows.map((r) => ({
    provider: parsed.data.provider,
    provider_market_id: Number(r.provider_market_id),
    provider_market_ref: r.provider_market_ref,
    title: r.title,
    category: r.category,
    status: r.status,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    url: r.url ?? undefined,
  }));
});

app.get("/v1/markets/new", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
  const schema = z.object({
    provider: z.string().min(1),
    category: z.string().min(1).optional(),
    since: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return { error: parsed.error.flatten() };

  const sinceDate = parseSince(parsed.data.since);
  if (!sinceDate) return { error: "invalid_since", message: "since must be ISO date or relative e.g. 24h, 7d" };

  const provRes = await query("select id from pmci.providers where code = $1", [parsed.data.provider]);
  if (provRes.rowCount === 0) return { error: "unknown_provider" };
  const providerId = provRes.rows[0].id;

  const category = parsed.data.category ?? null;
  const sinceTs = sinceDate.toISOString();

  const { rows } = await query(SQL.new_markets, [providerId, category, sinceTs, parsed.data.limit]);

  return rows.map((r) => ({
    provider: parsed.data.provider,
    provider_market_id: Number(r.provider_market_id),
    provider_market_ref: r.provider_market_ref,
    title: r.title,
    category: r.category,
    status: r.status,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    url: r.url ?? undefined,
  }));
});

app.get("/v1/health/freshness", async () => {
  try {
    const { rows: sr } = await query(`
      select
        now() as now,
        (select max(observed_at) from pmci.provider_market_snapshots) as latest_snapshot_at,
        (select count(*)::bigint from pmci.provider_markets) as provider_markets,
        (select count(*)::bigint from pmci.provider_market_snapshots) as snapshots,
        (select count(*)::bigint from pmci.market_families) as families,
        (select count(*)::bigint from pmci.v_market_links_current) as current_links;
    `);
    const summary = sr[0] ?? {};
    const now = summary.now ? new Date(summary.now) : new Date();
    const latest = summary.latest_snapshot_at ? new Date(summary.latest_snapshot_at) : null;
    const nowTs = now.getTime();
    const latestTs = latest ? latest.getTime() : null;
    const lagSeconds = latestTs == null ? null : Math.max(0, Math.round((nowTs - latestTs) / 1000));

    const providerCounts = await query(`
      select p.code as provider, max(s.observed_at) as latest_snapshot_at
      from pmci.providers p
      left join pmci.provider_markets pm on pm.provider_id = p.id
      left join pmci.provider_market_snapshots s on s.provider_market_id = pm.id
      group by p.code
      order by p.code;
    `);

    const latestByProvider = (providerCounts.rows || []).map((r) => {
      const lp = r.latest_snapshot_at ? new Date(r.latest_snapshot_at) : null;
      const lpTs = lp ? lp.getTime() : null;
      const lpLag = lpTs == null ? null : Math.max(0, Math.round((nowTs - lpTs) / 1000));
      return {
        provider: r.provider,
        latest_snapshot_at: r.latest_snapshot_at ?? null,
        lag_seconds: lpLag,
      };
    });

    const snapshots = Number(summary.snapshots ?? 0);
    let status = "ok";
    if (!Number.isFinite(lagSeconds) || lagSeconds == null) {
      status = snapshots === 0 ? "error" : "stale";
    } else if (snapshots === 0) {
      status = "error";
    } else if (lagSeconds > MAX_LAG_SECONDS) {
      status = "stale";
    }

    return {
      status,
      api_version: PMCI_API_VERSION,
      now: now.toISOString(),
      latest_snapshot_at: latest ? latest.toISOString() : null,
      lag_seconds: lagSeconds,
      latest_by_provider: latestByProvider,
      counts: {
        provider_markets: Number(summary.provider_markets ?? 0),
        snapshots,
        families: Number(summary.families ?? 0),
        current_links: Number(summary.current_links ?? 0),
      },
    };
  } catch (err) {
    return {
      status: "error",
      error: "db_error",
      message: err.message,
    };
  }
});

app.get("/v1/health/slo", async () => {
  const db = getDbMetrics();
  const p95 = percentile(requestMetrics.latenciesMs, 95);
  const errorRate = requestMetrics.total > 0 ? requestMetrics.errors / requestMetrics.total : 0;

  let freshness = null;
  try {
    const response = await app.inject({ method: "GET", url: "/v1/health/freshness" });
    freshness = response.json();
  } catch (_) {
    freshness = { status: "error", lag_seconds: null };
  }

  let projection = null;
  try {
    const projResponse = await app.inject({ method: "GET", url: "/v1/health/projection-ready" });
    projection = projResponse.json();
  } catch (_) {
    projection = {
      ready: false,
      error: "inject_failed",
      missing_steps: ["Could not reach /v1/health/projection-ready"],
    };
  }

  let observerHealth = null;
  try {
    const observerResponse = await app.inject({ method: "GET", url: "/v1/health/observer" });
    observerHealth = observerResponse.json();
  } catch (_) {
    observerHealth = { status: "error", rolling_success_rate: null };
  }

  const ingestionSuccessRate =
    observerHealth?.true_success_rate ??
    observerHealth?.rolling_success_rate ??
    null;

  const checks = {
    ingestion_success: {
      target: INGESTION_SUCCESS_TARGET,
      actual: ingestionSuccessRate,
      pass: typeof ingestionSuccessRate === "number"
        ? ingestionSuccessRate >= INGESTION_SUCCESS_TARGET
        : false,
    },
    api_p95_latency_ms: {
      target: API_P95_TARGET_MS,
      actual: p95 == null ? null : Math.round(p95),
      pass: p95 == null ? false : p95 <= API_P95_TARGET_MS,
    },
    freshness_lag_seconds: {
      target: MAX_LAG_SECONDS,
      actual: freshness?.lag_seconds ?? null,
      pass: typeof freshness?.lag_seconds === "number" ? freshness.lag_seconds <= MAX_LAG_SECONDS : false,
    },
    projection_ready: {
      target: true,
      actual: projection?.ready ?? false,
      pass: projection?.ready === true,
    },
  };

  const allPass = Object.values(checks).every((c) => c.pass === true);
  return {
    status: allPass ? "ok" : "degraded",
    started_at: requestMetrics.startedAt,
    api_version: PMCI_API_VERSION,
    request_metrics: {
      total: requestMetrics.total,
      errors: requestMetrics.errors,
      error_rate: Number(errorRate.toFixed(4)),
      p95_latency_ms: p95 == null ? null : Math.round(p95),
      sample_size: requestMetrics.latenciesMs.length,
    },
    db_metrics: db,
    freshness_health: freshness,
    projection_health: projection,
    observer_health: observerHealth,
    checks,
  };
});

app.get("/v1/health/projection-ready", async (req, reply) => {
  try {
    const { rows } = await query(`
      select
        (select count(*)::bigint from pmci.provider_markets) as provider_markets,
        (select count(*)::bigint from pmci.provider_market_snapshots) as snapshots,
        (select count(*)::bigint from pmci.market_families) as families,
        (select count(*)::bigint from pmci.v_market_links_current) as active_links,
        extract(
          epoch from (now() - (select max(observed_at) from pmci.provider_market_snapshots))
        )::int as lag_seconds;
    `);
    const row = rows[0] ?? {};

    const providerMarkets = Number(row.provider_markets ?? 0);
    const snapshots = Number(row.snapshots ?? 0);
    const families = Number(row.families ?? 0);
    const activeLinks = Number(row.active_links ?? 0);

    const lagRaw = row.lag_seconds;
    const lagSeconds =
      typeof lagRaw === "number" ? lagRaw : lagRaw == null ? null : Number(lagRaw);

    const providerMarketsPass = providerMarkets > 0;
    const snapshotsPass = snapshots > 0;
    const familiesPass = families > 0;
    const activeLinksPass = activeLinks > 0;
    const lagPass = typeof lagSeconds === "number" && lagSeconds <= MAX_LAG_SECONDS;

    const checks = {
      provider_markets: { count: providerMarkets, pass: providerMarketsPass },
      snapshots: { count: snapshots, pass: snapshotsPass },
      families: { count: families, pass: familiesPass },
      active_links: { count: activeLinks, pass: activeLinksPass },
      freshness_seconds: { lag: lagSeconds, pass: lagPass },
    };

    const missingSteps = [];
    if (!providerMarketsPass) {
      missingSteps.push("Run observer: npm run start (wait 1 cycle)");
    }
    if (!snapshotsPass) {
      missingSteps.push("Observer running but no snapshots yet, wait for next cycle");
    }
    if (!familiesPass) {
      missingSteps.push("Seed families: npm run seed:pmci");
    }
    if (!activeLinksPass) {
      missingSteps.push("No active links in v_market_links_current, check migrations");
    }
    if (typeof lagSeconds === "number" && lagSeconds > MAX_LAG_SECONDS) {
      missingSteps.push(`Snapshots stale (${lagSeconds}s), restart observer: npm run start`);
    }

    const ready =
      providerMarketsPass && snapshotsPass && familiesPass && activeLinksPass && lagPass;

    return {
      ready,
      api_version: PMCI_API_VERSION,
      checks,
      missing_steps: missingSteps,
    };
  } catch (err) {
    reply.code(503);
    return {
      ready: false,
      error: "db_error",
      message: err.message,
      missing_steps: ["Check DATABASE_URL and DB connectivity"],
    };
  }
});


app.get("/v1/health/observer", async (req, reply) => {
  try {
    const { rows } = await query(SQL.observer_health);
    if (rows.length === 0) {
      return {
        status: "no_data", latest_cycle_at: null, lag_seconds: null,
        rolling_success_rate: null, rolling_window_cycles: 0, error_totals: null,
      };
    }
    const latest = rows[0];
    const latestCycleAt = latest.cycle_at ? new Date(latest.cycle_at) : null;
    const lagSeconds = latestCycleAt
      ? Math.max(0, Math.round((Date.now() - latestCycleAt.getTime()) / 1000))
      : null;

    let totalAttempted = 0;
    let totalSucceeded = 0;
    let totalConfigured = 0;
    let trueNumerator = 0;  // pairs_succeeded only from rows that have pairs_configured > 0
    const errorTotals = {
      kalshi_fetch_errors: 0, polymarket_fetch_errors: 0,
      spread_insert_errors: 0, pmci_ingestion_errors: 0, json_parse_errors: 0,
    };
    for (const row of rows) {
      const configured = Number(row.pairs_configured ?? 0);
      totalAttempted += Number(row.pairs_attempted ?? 0);
      totalSucceeded += Number(row.pairs_succeeded ?? 0);
      totalConfigured += configured;
      if (configured > 0) trueNumerator += Number(row.pairs_succeeded ?? 0);
      errorTotals.kalshi_fetch_errors += Number(row.kalshi_fetch_errors ?? 0);
      errorTotals.polymarket_fetch_errors += Number(row.polymarket_fetch_errors ?? 0);
      errorTotals.spread_insert_errors += Number(row.spread_insert_errors ?? 0);
      errorTotals.pmci_ingestion_errors += Number(row.pmci_ingestion_errors ?? 0);
      errorTotals.json_parse_errors += Number(row.json_parse_errors ?? 0);
    }

    const rollingSuccessRate = totalAttempted > 0 ? totalSucceeded / totalAttempted : null;
    const trueSuccessRate = totalConfigured > 0 ? trueNumerator / totalConfigured : null;
    const status = lagSeconds == null || lagSeconds > MAX_LAG_SECONDS ? "stale" : "ok";

    return {
      status,
      latest_cycle_at: latestCycleAt ? latestCycleAt.toISOString() : null,
      lag_seconds: lagSeconds,
      api_version: PMCI_API_VERSION,
      rolling_success_rate: rollingSuccessRate,
      true_success_rate: trueSuccessRate,
      pairs_configured_total: totalConfigured,
      rolling_window_cycles: rows.length,
      error_totals: errorTotals,
    };
  } catch (err) {
    reply.code(500);
    return { status: "error", error: "db_error", message: err.message };
  }
});

app.get("/v1/health/usage", async (req, reply) => {
  try {
    const { rows } = await query(`
      select
        path,
        count(*)::int as total_requests,
        round(avg(latency_ms))::int as avg_latency_ms,
        sum(case when status >= 500 then 1 else 0 end)::int as error_count,
        max(logged_at) as last_seen_at
      from pmci.request_log
      where logged_at > now() - interval '24 hours'
      group by path
      order by total_requests desc
    `);
    return { window: "24h", endpoints: rows };
  } catch (err) {
    reply.code(500);
    return { error: "db_error", message: err.message };
  }
});

app.get("/v1/market-families", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
  const schema = z.object({ event_id: z.string().uuid() });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return { error: parsed.error.flatten() };

  const { rows: families } = await query(SQL.families_by_event, [parsed.data.event_id]);
  if (families.length === 0) return [];

  const familyIds = families.map((f) => f.id);
  const { rows: allLinks } = await query(SQL.links_for_families_batch, [familyIds]);
  const allMarketIds = [...new Set(allLinks.map((l) => l.provider_market_id))];
  const { rows: snaps } = allMarketIds.length
    ? await query(SQL.latest_snapshots_for_markets, [allMarketIds])
    : { rows: [] };

  const latestByMarketId = new Map(snaps.map((s) => [s.provider_market_id, s]));
  const linksByFamily = new Map();
  for (const l of allLinks) {
    if (!linksByFamily.has(l.family_id)) linksByFamily.set(l.family_id, []);
    linksByFamily.get(l.family_id).push(l);
  }

  return families.map((f) => {
    const links = linksByFamily.get(f.id) ?? [];
    const consensus = computeConsensus(links, latestByMarketId);
    return {
      id: Number(f.id),
      canonical_event_id: f.canonical_event_id,
      canonical_market_id: f.canonical_market_id,
      label: f.label,
      consensus_price: consensus,
      num_links: links.length,
    };
  });
});

app.get("/v1/market-links", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
  const schema = z.object({ family_id: z.coerce.number().int().positive() });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return { error: parsed.error.flatten() };

  const { rows: links } = await query(SQL.current_links_for_family, [parsed.data.family_id]);
  const marketIds = links.map(l => l.provider_market_id);
  const { rows: snaps } = await query(SQL.latest_snapshots_for_markets, [marketIds]);

  const latest = new Map(snaps.map(s => [s.provider_market_id, s]));
  const consensus = computeConsensus(links, latest);

  return links.map(l => {
    const snap = latest.get(l.provider_market_id);
    const price = snap?.price_yes ?? null;

    return {
      id: Number(l.id),
      family_id: Number(l.family_id),
      provider: l.provider,
      provider_market_id: Number(l.provider_market_id),
      provider_market_ref: l.provider_market_ref,
      relationship_type: l.relationship_type,
      status: l.status,
      link_version: Number(l.link_version),
      confidence: Number(l.confidence),
      price,
      consensus_price: consensus,
      divergence: computeDivergence(price, consensus),
      correlation_window: l.correlation_window,
      lag_seconds: l.lag_seconds == null ? null : Number(l.lag_seconds),
      correlation_strength: l.correlation_strength == null ? null : Number(l.correlation_strength),
      break_rate: l.break_rate == null ? null : Number(l.break_rate),
      last_validated_at: l.last_validated_at,
      staleness_score: l.staleness_score == null ? null : Number(l.staleness_score),
      reasons: l.reasons ?? {},
      market_title: l.market_title,
    };
  });
});

app.get("/v1/signals/divergence", { preHandler: assertFreshness, rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
  const schema = z.object({ family_id: z.coerce.number().int().positive() });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return { error: parsed.error.flatten() };

  const resp = await app.inject({ method: "GET", url: `/v1/market-links?family_id=${parsed.data.family_id}` });
  const rows = resp.json();
  if (rows?.error) return rows;

  return rows
    .filter(r => r.divergence != null)
    .sort((a, b) => Number(b.divergence) - Number(a.divergence))
    .map(r => ({
      family_id: r.family_id,
      provider: r.provider,
      provider_market_id: r.provider_market_id,
      relationship_type: r.relationship_type,
      price: r.price,
      consensus_price: r.consensus_price,
      divergence: r.divergence,
    }));
});

app.get("/v1/signals/top-divergences", { preHandler: assertFreshness, rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
  const schema = z.object({
    event_id: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return { error: parsed.error.flatten() };

  const { rows: families } = await query(SQL.families_by_event, [parsed.data.event_id]);
  if (families.length === 0) return [];

  const familyIds = families.map((f) => f.id);
  const { rows: allLinks } = await query(SQL.links_for_families_batch, [familyIds]);
  const allMarketIds = [...new Set(allLinks.map((l) => l.provider_market_id))];
  const { rows: snaps } = allMarketIds.length
    ? await query(SQL.latest_snapshots_for_markets, [allMarketIds])
    : { rows: [] };

  const latestByMarketId = new Map(snaps.map((s) => [s.provider_market_id, s]));
  const linksByFamily = new Map();
  for (const l of allLinks) {
    if (!linksByFamily.has(l.family_id)) linksByFamily.set(l.family_id, []);
    linksByFamily.get(l.family_id).push(l);
  }

  const results = [];

  for (const f of families) {
    const links = linksByFamily.get(f.id) ?? [];
    if (links.length === 0) continue;

    const consensus = computeConsensus(links, latestByMarketId);

    const legs = [];
    let maxDivergence = null;
    let lastObservedAt = null;

    for (const l of links) {
      const snap = latestByMarketId.get(l.provider_market_id);
      const priceYes = snap?.price_yes ?? null;
      const div = computeDivergence(priceYes, consensus);
      if (div != null && (maxDivergence == null || div > maxDivergence)) maxDivergence = div;
      if (snap?.observed_at) {
        const t = new Date(snap.observed_at).getTime();
        if (lastObservedAt == null || t > lastObservedAt) lastObservedAt = snap.observed_at;
      }
      legs.push({
        provider: l.provider,
        provider_market_id: Number(l.provider_market_id),
        provider_market_ref: l.provider_market_ref,
        price_yes: priceYes,
        divergence: div,
        relationship_type: l.relationship_type,
        confidence: Number(l.confidence),
      });
    }

    results.push({
      family_id: Number(f.id),
      label: f.label,
      consensus_price: consensus,
      max_divergence: maxDivergence,
      last_observed_at: lastObservedAt,
      legs,
    });
  }

  results.sort((a, b) => {
    const da = a.max_divergence ?? -1;
    const db = b.max_divergence ?? -1;
    return db - da;
  });

  const top = results.slice(0, parsed.data.limit);
  return top;
});

app.get("/v1/review/queue", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
  const schema = z.object({
    category: z.string().min(1).default("politics"),
    limit: z.coerce.number().int().min(1).max(100).default(1),
    min_confidence: z.coerce.number().min(0).max(1).default(0.88),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return { error: parsed.error.flatten() };

  const { rows: queueRows } = await query(SQL.review_queue, [
    parsed.data.category,
    parsed.data.min_confidence,
    parsed.data.limit,
  ]);
  if (queueRows.length === 0) return [];

  const marketIds = [
    ...queueRows.map((r) => r.provider_market_id_a),
    ...queueRows.map((r) => r.provider_market_id_b),
  ];
  const { rows: snapRows } = await query(SQL.latest_snapshots_with_raw, [marketIds]);
  const snapByMarket = new Map(snapRows.map((s) => [Number(s.provider_market_id), s]));

  return queueRows.map((r) => {
    const snapA = snapByMarket.get(Number(r.provider_market_id_a));
    const snapB = snapByMarket.get(Number(r.provider_market_id_b));
    const reasons = r.reasons ?? {};
    return {
      proposed_id: Number(r.proposed_id),
      proposed_relationship_type: r.proposed_relationship_type,
      confidence: Number(r.confidence),
      reasons,
      proposal_type: reasons.proposal_type ?? "new_pair",
      target_family_id: reasons.target_family_id != null ? Number(reasons.target_family_id) : undefined,
      created_at: r.created_at,
      market_a: {
        provider: r.provider_code_a,
        provider_market_id: Number(r.provider_market_id_a),
        provider_market_ref: r.ref_a,
        title: r.title_a,
        category: r.category_a,
        status: r.status_a,
        url: r.url_a ?? undefined,
        close_time: r.close_time_a ?? undefined,
        latest_snapshot: snapA
          ? {
              price_yes: snapA.price_yes != null ? Number(snapA.price_yes) : null,
              observed_at: snapA.observed_at,
              price_source: snapA.raw?._pmci?.price_source ?? null,
            }
          : null,
      },
      market_b: {
        provider: r.provider_code_b,
        provider_market_id: Number(r.provider_market_id_b),
        provider_market_ref: r.ref_b,
        title: r.title_b,
        category: r.category_b,
        status: r.status_b,
        url: r.url_b ?? undefined,
        close_time: r.close_time_b ?? undefined,
        latest_snapshot: snapB
          ? {
              price_yes: snapB.price_yes != null ? Number(snapB.price_yes) : null,
              observed_at: snapB.observed_at,
              price_source: snapB.raw?._pmci?.price_source ?? null,
            }
          : null,
      },
    };
  });
});

app.post("/v1/review/decision", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
  const schema = z.object({
    proposed_id: z.number().int().positive(),
    decision: z.enum(["accept", "reject", "skip"]),
    relationship_type: z.enum(["equivalent", "proxy"]),
    note: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return { error: parsed.error.flatten() };

  const propRes = await query(
    `SELECT id, provider_market_id_a, provider_market_id_b, confidence, reasons, decision
     FROM pmci.proposed_links WHERE id = $1 AND decision IS NULL`,
    [parsed.data.proposed_id],
  );
  if (propRes.rowCount === 0) return { error: "proposal_not_found_or_already_decided" };
  const prop = propRes.rows[0];
  const idA = Number(prop.provider_market_id_a);
  const idB = Number(prop.provider_market_id_b);
  const reasons = prop.reasons ?? {};

  if (parsed.data.decision === "accept") {
    const marketRes = await query(
      `SELECT pm.id, pm.provider_id, p.code, pm.provider_market_ref, pm.event_ref
       FROM pmci.provider_markets pm JOIN pmci.providers p ON p.id = pm.provider_id
       WHERE pm.id IN ($1, $2)`,
      [idA, idB],
    );
    const byId = new Map(marketRes.rows.map((r) => [Number(r.id), r]));
    const ma = byId.get(idA);
    const mb = byId.get(idB);
    if (!ma || !mb) return { error: "market_not_found" };

    const isAttach = reasons.proposal_type === "attach_to_family" && reasons.target_family_id != null;
    let familyId = isAttach ? Number(reasons.target_family_id) : null;

    if (!familyId) {
      const topicKey = (mb.event_ref || mb.provider_market_ref || "").split("#")[0].replace(/-/g, " ").split(/\s+/)[0] || "politics";
      const entityKey = reasons.matched_tokens?.[0] || "unknown";
      const label = `politics::${topicKey}::::${entityKey}`;
      const notes = `ref_a=${ma.provider_market_ref} ref_b=${mb.provider_market_ref} review-accepted`;

      const famRes = await query(`SELECT id FROM pmci.market_families WHERE label = $1`, [label]);
      familyId = famRes.rows?.[0]?.id;
      if (!familyId) {
        const ceRes = await query(
          `SELECT id FROM pmci.canonical_events WHERE slug = $1 LIMIT 1`,
          [mb.event_ref?.split("#")[0] || ""],
        );
        const canonicalEventId = ceRes.rows?.[0]?.id ?? null;
        const insFam = await query(
          `INSERT INTO pmci.market_families (label, notes, canonical_event_id) VALUES ($1, $2, $3) RETURNING id`,
          [label, notes, canonicalEventId],
        );
        familyId = insFam.rows?.[0]?.id;
      }
    }

    const nextVer = await query(SQL.next_linker_run_version);
    const version = Number(nextVer.rows[0].next_version);
    await query(SQL.insert_linker_run, [version, isAttach ? "review accept (attach)" : "review accept"]);

    const reasonsJson = JSON.stringify(reasons);
    if (isAttach) {
      const linksInFamily = await query(
        `SELECT provider_market_id FROM pmci.market_links WHERE family_id = $1 AND status = 'active'`,
        [familyId],
      );
      const linkedIds = new Set((linksInFamily.rows || []).map((r) => Number(r.provider_market_id)));
      const toAdd = [idA, idB].filter((id) => !linkedIds.has(id));
      for (const marketId of toAdd) {
        const m = byId.get(marketId);
        if (m) {
          await query(SQL.insert_market_link, [
            familyId,
            m.provider_id,
            marketId,
            parsed.data.relationship_type,
            "active",
            version,
            Number(prop.confidence),
            null,
            null,
            null,
            null,
            null,
            null,
            reasonsJson,
          ]);
        }
      }
    } else {
      await query(SQL.insert_market_link, [
        familyId,
        ma.provider_id,
        idA,
        parsed.data.relationship_type,
        "active",
        version,
        Number(prop.confidence),
        null,
        null,
        null,
        null,
        null,
        null,
        reasonsJson,
      ]);
      await query(SQL.insert_market_link, [
        familyId,
        mb.provider_id,
        idB,
        parsed.data.relationship_type,
        "active",
        version,
        Number(prop.confidence),
        null,
        null,
        null,
        null,
        null,
        null,
        reasonsJson,
      ]);
    }

    await query(
      `UPDATE pmci.proposed_links SET decision = 'accepted', reviewed_at = now(), reviewer_note = $2,
        accepted_family_id = $3, accepted_link_version = $4, accepted_relationship_type = $5 WHERE id = $1`,
      [parsed.data.proposed_id, parsed.data.note ?? "accepted", familyId, version, parsed.data.relationship_type],
    );
    await query(
      `INSERT INTO pmci.review_decisions (proposed_link_id, decision, relationship_type, reviewer_note) VALUES ($1, 'accepted', $2, $3)`,
      [parsed.data.proposed_id, parsed.data.relationship_type, parsed.data.note ?? "accepted"],
    );
    const snapCheck = await query(
      `SELECT COUNT(*)::int AS count
       FROM pmci.provider_market_snapshots s
       JOIN pmci.market_links ml ON ml.provider_market_id = s.provider_market_id
       WHERE ml.family_id = $1
         AND ml.status = 'active'
         AND s.observed_at > now() - interval '1 hour'`,
      [familyId],
    );
    const snapshotCount = snapCheck.rows?.[0]?.count ?? 0;
    const divergenceAvailable = Number(snapshotCount) >= 2;
    return {
      ok: true,
      decision: "accepted",
      family_id: Number(familyId),
      link_version: version,
      divergence_available: divergenceAvailable,
      divergence_note: divergenceAvailable
        ? "Both markets have recent snapshots. Family should appear in /v1/signals/top-divergences."
        : "No recent snapshots for one or both markets yet. Divergence signals will appear after the observer ingests this pair.",
    };
  }

  const decision = parsed.data.decision === "reject" ? "rejected" : "skipped";
  await query(
    `UPDATE pmci.proposed_links SET decision = $2, reviewed_at = now(), reviewer_note = $3 WHERE id = $1`,
    [parsed.data.proposed_id, decision, parsed.data.note ?? null],
  );
  await query(
    `INSERT INTO pmci.review_decisions (proposed_link_id, decision, reviewer_note) VALUES ($1, $2, $3)`,
    [parsed.data.proposed_id, decision, parsed.data.note ?? null],
  );
  return { ok: true, decision };
});

app.post("/v1/resolve/link", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
  const schema = z.object({
    family_id: z.number().int().positive(),
    provider_code: z.enum(["kalshi", "polymarket"]),
    provider_market_id: z.number().int().positive(), // pmci.provider_markets.id
    relationship_type: z.enum(["identical","equivalent","proxy","correlated"]),
    confidence: z.number().min(0).max(1),
    reasons: z.record(z.any()).default({}),
    correlation_window: z.string().optional(),
    lag_seconds: z.number().int().optional(),
    correlation_strength: z.number().min(-1).max(1).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return { error: parsed.error.flatten() };

  const adminKey = process.env.PMCI_ADMIN_KEY;
  if (adminKey && req.headers["x-pmci-admin-key"] !== adminKey) {
    return { error: "unauthorized" };
  }

  const prov = await query("select id from pmci.providers where code = $1", [parsed.data.provider_code]);
  if (prov.rowCount === 0) return { error: "unknown_provider" };
  const providerId = prov.rows[0].id;

  const next = await query(SQL.next_linker_run_version);
  const version = Number(next.rows[0].next_version);
  await query(SQL.insert_linker_run, [version, "manual resolve/link"]);

  const res = await query(SQL.insert_market_link, [
    parsed.data.family_id,
    providerId,
    parsed.data.provider_market_id,
    parsed.data.relationship_type,
    "active",
    version,
    parsed.data.confidence,
    parsed.data.correlation_window ?? null,
    parsed.data.lag_seconds ?? null,
    parsed.data.correlation_strength ?? null,
    null,
    null,
    null,
    JSON.stringify(parsed.data.reasons ?? {}),
  ]);

  const row = res.rows[0];
  return { link_id: Number(row.id), link_version: Number(row.link_version), status: row.status };
});

const PORT = Number(process.env.PORT ?? 8787);
app.listen({ port: PORT, host: "0.0.0.0" });
