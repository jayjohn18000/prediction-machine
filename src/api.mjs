import Fastify from "fastify";
import { z } from "zod";
import { query, getDbMetrics } from "./db.mjs";
import { SQL } from "./queries.mjs";

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

app.addHook("onResponse", async (req, reply) => {
  const started = req.raw._pmciStartMs ?? Date.now();
  const latency = Date.now() - started;
  requestMetrics.total += 1;
  if (reply.statusCode >= 500) requestMetrics.errors += 1;
  recordLatency(latency);
});

app.addHook("onRequest", async (req) => {
  req.raw._pmciStartMs = Date.now();
});

app.get("/v1/providers", async () => {
  const { rows } = await query(SQL.providers);
  return rows.map(r => ({ code: r.code, name: r.name }));
});

app.get("/v1/coverage", async (req) => {
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

app.get("/v1/coverage/summary", async (req) => {
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

app.get("/v1/markets/unlinked", async (req) => {
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

app.get("/v1/markets/new", async (req) => {
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
  const ingestionSuccessRate = 1 - errorRate;

  let freshness = null;
  try {
    const response = await app.inject({ method: "GET", url: "/v1/health/freshness" });
    freshness = response.json();
  } catch (_) {
    freshness = { status: "error", lag_seconds: null };
  }

  const checks = {
    ingestion_success: {
      target: INGESTION_SUCCESS_TARGET,
      actual: Number(ingestionSuccessRate.toFixed(4)),
      pass: ingestionSuccessRate >= INGESTION_SUCCESS_TARGET,
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
  };

  const allPass = Object.values(checks).every((c) => c.pass === true);
  return {
    status: allPass ? "ok" : "degraded",
    started_at: requestMetrics.startedAt,
    request_metrics: {
      total: requestMetrics.total,
      errors: requestMetrics.errors,
      error_rate: Number(errorRate.toFixed(4)),
      p95_latency_ms: p95 == null ? null : Math.round(p95),
      sample_size: requestMetrics.latenciesMs.length,
    },
    db_metrics: db,
    freshness_health: freshness,
    checks,
  };
});


app.get("/v1/market-families", async (req) => {
  const schema = z.object({ event_id: z.string().uuid() });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return { error: parsed.error.flatten() };

  const { rows: families } = await query(SQL.families_by_event, [parsed.data.event_id]);
  const out = [];

  for (const f of families) {
    const { rows: links } = await query(SQL.current_links_for_family, [f.id]);
    const marketIds = links.map(l => l.provider_market_id);
    const { rows: snaps } = await query(SQL.latest_snapshots_for_markets, [marketIds]);

    const latest = new Map(snaps.map(s => [s.provider_market_id, s]));
    const consensus = computeConsensus(links, latest);

    out.push({
      id: Number(f.id),
      canonical_event_id: f.canonical_event_id,
      canonical_market_id: f.canonical_market_id,
      label: f.label,
      consensus_price: consensus,
      num_links: links.length,
    });
  }

  return out;
});

app.get("/v1/market-links", async (req) => {
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

app.get("/v1/signals/divergence", async (req) => {
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

app.get("/v1/signals/top-divergences", async (req) => {
  const schema = z.object({
    event_id: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return { error: parsed.error.flatten() };

  const { rows: families } = await query(SQL.families_by_event, [parsed.data.event_id]);
  const results = [];

  for (const f of families) {
    const { rows: links } = await query(SQL.current_links_for_family, [f.id]);
    const marketIds = links.map(l => l.provider_market_id);
    if (marketIds.length === 0) continue;

    const { rows: snaps } = await query(SQL.latest_snapshots_for_markets, [marketIds]);
    const latest = new Map(snaps.map(s => [s.provider_market_id, s]));
    const consensus = computeConsensus(links, latest);

    const legs = [];
    let maxDivergence = null;
    let lastObservedAt = null;

    for (const l of links) {
      const snap = latest.get(l.provider_market_id);
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

app.post("/v1/resolve/link", async (req) => {
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
