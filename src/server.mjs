/**
 * PMCI Fastify app bootstrap. Builds app with hooks and route modules.
 * Entrypoint remains src/api.mjs (calls buildApp then listen).
 */
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { getPmciApiConfig } from "./platform/config-schema.mjs";
import { query, getDbMetrics, withTransaction } from "./db.mjs";
import { SQL } from "./queries.mjs";
import { createPmciClient } from "../lib/pmci-ingestion.mjs";
import { registerHealthRoutes } from "./routes/health.mjs";
import { registerCoverageRoutes } from "./routes/coverage.mjs";
import { registerMarketsRoutes } from "./routes/markets.mjs";
import { registerFamiliesRoutes } from "./routes/families.mjs";
import { registerSignalsRoutes } from "./routes/signals.mjs";
import { registerReviewRoutes } from "./routes/review.mjs";
import { registerLinksRoutes } from "./routes/links.mjs";
import { registerAdminJobRoutes } from "./routes/admin-jobs.mjs";
import { registerMmDashboardRoutes } from "./routes/mm-dashboard.mjs";
import { resolveProviderIdByCode } from "./repositories/providers-repo.mjs";
import { percentile, typeFactor, computeConsensus, computeDivergence } from "./utils/metrics.mjs";
import { parseSince } from "./utils/time.mjs";
import { enqueueRequestLog, startRequestLogFlusher } from "./services/request-log-buffer.mjs";

const PMCI_API_VERSION = "2026-03-02";

export async function buildApp() {
  const config = getPmciApiConfig(process.env);
  const MAX_LAG_SECONDS = config.maxLagSeconds;
  const INGESTION_SUCCESS_TARGET = config.ingestionSuccessTarget;
  const API_P95_TARGET_MS = config.apiP95TargetMs;
  const RATE_LIMIT_CONFIG = {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    keyGenerator: (req) => req.headers["x-pmci-api-key"] ?? req.ip,
    errorResponseBuilder: () => ({
      error: "rate_limited",
      message: "Too many requests. See max and timeWindow in response headers.",
    }),
  };

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
    if (logClient) {
      await logClient.connect();
      // Prevent unhandled ETIMEDOUT / ECONNRESET on the raw pg.Client from
      // crashing the API process. Disable log writes and let queries no-op.
      logClient.on('error', (err) => {
        console.error('[pmci-logclient] connection error — disabling log writes:', err.message);
        logClient = null;
      });
    }
  } catch (_) {
    logClient = null;
  }

  // Sports ingestion runs every 4 hours — use a much higher lag threshold for sports routes.
  // Politics observer runs every 60s so MAX_LAG_SECONDS (default 120s) remains appropriate there.
  const SPORTS_MAX_LAG_SECONDS = Number(process.env.PMCI_SPORTS_MAX_LAG_SECONDS ?? 18000); // 5 hours

  startRequestLogFlusher(logClient);

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

  // 60-second TTL cache: event_id (uuid string) → category string.
  // Avoids a DB round-trip per request when assertFreshness resolves the threshold.
  const eventCategoryCache = new Map(); // key: event_id, value: { category, fetchedAt }
  const EVENT_CATEGORY_TTL_MS = 60_000;

  async function getEventCategory(eventId) {
    const cached = eventCategoryCache.get(eventId);
    if (cached && Date.now() - cached.fetchedAt < EVENT_CATEGORY_TTL_MS) {
      return cached.category;
    }
    try {
      const { rows } = await query(
        `select category from pmci.canonical_events where id = $1 limit 1`,
        [eventId]
      );
      const category = rows[0]?.category ?? null;
      eventCategoryCache.set(eventId, { category, fetchedAt: Date.now() });
      return category;
    } catch {
      return null;
    }
  }

  async function assertFreshness(req, reply) {
    try {
      const lag = await getCachedLag();

      // Resolve per-category threshold when an event_id is present on the request.
      // Sports canonical events tolerate higher lag (4-hour ingest cycle).
      let maxLag = MAX_LAG_SECONDS;
      const eventId = req.query?.event_id;
      if (eventId) {
        const category = await getEventCategory(eventId);
        if (category === 'sports') maxLag = SPORTS_MAX_LAG_SECONDS;
      }

      if (lag == null || lag > maxLag) {
        reply.code(503);
        return reply.send({
          error: "stale_data",
          lag_seconds: lag,
          max_lag_seconds: maxLag,
          message: `Data is stale (${lag}s ago, max ${maxLag}s). Observer may be down.`,
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
    PMCI_API_KEY: config.apiKey,
    PMCI_ADMIN_KEY: config.adminKey,
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

    const path = req.url.split("?")[0];
    if (path.startsWith("/v1/health")) return;

    const provided = req.headers["x-pmci-api-key"];
    const hint = provided ? String(provided).slice(-4) : null;
    enqueueRequestLog({
      method: req.method,
      path,
      status: reply.statusCode,
      latency_ms: latency,
      api_key_hint: hint,
      timestamp: new Date(),
    });
  });

  app.addHook("onRequest", async (req) => {
    req.raw._pmciStartMs = Date.now();
  });

  const LOCAL_CORS_ORIGINS = new Set([
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:4173",
    "http://localhost:4173",
    "https://lovable.dev",
  ]);

  const CORS_ORIGIN_PATTERNS = [
    /^https:\/\/[a-z0-9-]+\.lovable\.app$/,
    /^https:\/\/[a-z0-9-]+\.lovableproject\.com$/,
    /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/,
  ];

  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    const originAllowed =
      origin &&
      (LOCAL_CORS_ORIGINS.has(origin) ||
        CORS_ORIGIN_PATTERNS.some((p) => p.test(origin)));
    if (originAllowed) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type, x-pmci-api-key");
    }

    if (req.method === "OPTIONS") {
      // Chrome Private Network Access: allow HTTPS pages to call HTTP localhost
      reply.header("Access-Control-Allow-Private-Network", "true");
      reply.code(204);
      return reply.send();
    }
  });

  app.addHook("onRequest", async (req, reply) => {
    const apiKey = config.apiKey;
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
  registerLinksRoutes(app, deps);
  registerAdminJobRoutes(app, deps);
  registerMmDashboardRoutes(app, deps);

  return app;
}
