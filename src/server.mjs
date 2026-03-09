/**
 * PMCI Fastify app bootstrap. Builds app with hooks and route modules.
 * Entrypoint remains src/api.mjs (calls buildApp then listen).
 */
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { loadEnv } from "./platform/env.mjs";
import { query, getDbMetrics, withTransaction } from "./db.mjs";
import { SQL } from "./queries.mjs";
import { createPmciClient } from "../lib/pmci-ingestion.mjs";
import { registerHealthRoutes } from "./routes/health.mjs";
import { registerCoverageRoutes } from "./routes/coverage.mjs";
import { registerMarketsRoutes } from "./routes/markets.mjs";
import { registerFamiliesRoutes } from "./routes/families.mjs";
import { registerSignalsRoutes } from "./routes/signals.mjs";
import { registerReviewRoutes } from "./routes/review.mjs";
import { resolveProviderIdByCode } from "./repositories/providers-repo.mjs";

loadEnv();

const MAX_LAG_SECONDS = Number(process.env.PMCI_MAX_LAG_SECONDS ?? "120");
const INGESTION_SUCCESS_TARGET = Number(process.env.PMCI_INGESTION_SUCCESS_TARGET ?? "0.99");
const API_P95_TARGET_MS = Number(process.env.PMCI_API_P95_TARGET_MS ?? "500");
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
  return den <= 0 ? null : num / den;
}

function computeDivergence(price, consensus) {
  if (price == null || consensus == null) return null;
  return Math.abs(Number(price) - Number(consensus));
}

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

export async function buildApp() {
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

  let logClient = null;
  try {
    logClient = createPmciClient();
    if (logClient) await logClient.connect();
  } catch (_) {
    logClient = null;
  }

  // 5-second TTL cache for freshness lag — eliminates repeated max(observed_at) scans
  // when assertFreshness fires on every /v1/signals/* hit and /v1/health/slo polls.
  const freshnessCache = { lag: null, fetchedAt: 0 };
  const FRESHNESS_CACHE_TTL_MS = 5000;

  async function getCachedLag() {
    if (Date.now() - freshnessCache.fetchedAt < FRESHNESS_CACHE_TTL_MS) {
      return freshnessCache.lag;
    }
    const { rows } = await query(
      `select extract(epoch from (now() - max(observed_at)))::int as lag_seconds
       from pmci.provider_market_snapshots`
    );
    freshnessCache.lag = rows[0]?.lag_seconds != null ? Number(rows[0].lag_seconds) : null;
    freshnessCache.fetchedAt = Date.now();
    return freshnessCache.lag;
  }

  async function assertFreshness(req, reply) {
    try {
      const lag = await getCachedLag();
      if (lag == null || lag > MAX_LAG_SECONDS) {
        reply.code(503);
        return reply.send({
          error: "stale_data",
          lag_seconds: lag,
          max_lag_seconds: MAX_LAG_SECONDS,
          message: `Data is stale (${lag}s ago, max ${MAX_LAG_SECONDS}s). Observer may be down.`,
        });
      }
    } catch (err) {
      reply.code(503);
      return reply.send({ error: "freshness_check_failed", message: err.message });
    }
  }

  const deps = {
    query,
    getDbMetrics,
    withTransaction,
    resolveProviderIdByCode,
    SQL,
    logClient,
    requestMetrics,
    RATE_LIMIT_CONFIG,
    PMCI_API_VERSION,
    MAX_LAG_SECONDS,
    INGESTION_SUCCESS_TARGET,
    API_P95_TARGET_MS,
    percentile,
    typeFactor,
    computeConsensus,
    computeDivergence,
    parseSince,
    assertFreshness,
    z,
  };

  const app = Fastify({ logger: true });
  deps.app = app;

  await app.register(rateLimit, { global: false });

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
          [req.method, path, reply.statusCode, latency, hint]
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

  registerHealthRoutes(app, deps);
  registerCoverageRoutes(app, deps);
  registerMarketsRoutes(app, deps);
  registerFamiliesRoutes(app, deps);
  registerSignalsRoutes(app, deps);
  registerReviewRoutes(app, deps);

  return app;
}
