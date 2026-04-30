#!/usr/bin/env node
/**
 * MM orchestrator runtime: HTTP /health/mm + Kalshi L2 depth (W1) + reconcile + main quoting loop (W4).
 * Env: PORT (default 8790), DATABASE_URL, SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY (preferred for depth REST writes; else depth uses DATABASE_URL + Postgres INSERT),
 * KALSHI_DEMO_* , MM_DURATION_MS empty = run forever, MM_TICK_MS (default 5000).
 *
 * Depth uses DEMO Kalshi WebSocket only (never production WS). Restart the runtime to pick up
 * newly enabled markets — dynamic re-subscription is out of scope (post-W6 B).
 */

import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

import { createClient } from "@supabase/supabase-js";
import Fastify from "fastify";
import {
  runMmOrchestratorLoop,
  fetchEnabledMarketConfigs,
  kalshiTradeBaseUrlFromEnv,
} from "../../lib/mm/orchestrator.mjs";
import { createPgClient } from "../../lib/mm/order-store.mjs";
import { loadPrivateKey } from "../../lib/providers/kalshi-ws-auth.mjs";
import { startDepthIngestion, makePgDepthWriter } from "../../lib/ingestion/depth.mjs";

const PORT = Number(process.env.PORT ?? 8790);

/**
 * DEMO depth WS only. Prefer explicit KALSHI_WS_URL / KALSHI_DEMO_WS_URL; else derive from
 * KALSHI_BASE (or kalshiTradeBaseUrlFromEnv default) when host is demo-api.kalshi.co;
 * otherwise fall back to the public demo WS endpoint (never production elections WS).
 */
function resolveKalshiDemoDepthWsUrl() {
  const explicit =
    process.env.KALSHI_WS_URL?.trim() || process.env.KALSHI_DEMO_WS_URL?.trim();
  if (explicit) return explicit;

  const rest = kalshiTradeBaseUrlFromEnv().replace(/\/$/, "");
  try {
    const u = new URL(rest);
    if (!/demo-api\.kalshi\.co$/i.test(u.hostname)) {
      return "wss://demo-api.kalshi.co/trade-api/ws/v2";
    }
    u.protocol = "wss:";
    const p = u.pathname.replace(/\/$/, "");
    u.pathname = p.endsWith("/trade-api/v2") ? p.replace(/\/v2$/, "/ws/v2") : "/trade-api/ws/v2";
    return u.href.replace(/\/$/, "");
  } catch {
    return "wss://demo-api.kalshi.co/trade-api/ws/v2";
  }
}

function createServiceRoleSupabase() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** @type {Record<string, unknown>} */
const health = {
  ok: true,
  role: "mm-runtime",
  startedAt: null,
  listenedAt: null,
  lastReconcileAt: null,
  reconcilePhase: null,
  reconcileSkipped: null,
  lastMainLoopTickAt: null,
  loopTick: 0,
  lastSessionLineCount: 0,
  lastOrchestratorError: null,
  /** @deprecated Use depthSubscribedConfigured; kept for backward compatibility. */
  depthSubscribedTickers: 0,
  depthSubscribedConfigured: null,
  depthSubscribedConnected: null,
  depthLastUpdateSecondsAgo: null,
  depthTickersStale: null,
  depthStartedAt: null,
  depthStartError: null,
  depthStartAttempts: 0,
  depthStartLastAttemptAt: null,
};

const DEPTH_START_RETRY_BASE_MS = 1000;
const DEPTH_START_RETRY_CAP_MS = 30_000;

/**
 * Wrap startDepthIngestion in an indefinite exponential-backoff retry loop.
 * Caveat-3 fix: a transient initial-handshake failure used to leave the runtime
 * depth-less until a process restart; now we retry in the background and the
 * orchestrator loop continues quoting against the public REST snapshot meanwhile.
 *
 * @template T
 * @param {() => Promise<T>} attempt
 * @param {(state: { attempt: number, nextDelayMs: number, error: Error }) => void} [onError]
 * @returns {Promise<T>}
 */
async function startDepthWithRetry(attempt, onError) {
  let i = 0;
  while (true) {
    try {
      return await attempt();
    } catch (e) {
      const err = /** @type {Error} */ (e);
      const nextDelayMs = Math.min(
        DEPTH_START_RETRY_CAP_MS,
        DEPTH_START_RETRY_BASE_MS * 2 ** i,
      );
      try {
        onError?.({ attempt: i + 1, nextDelayMs, error: err });
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, nextDelayMs));
      i += 1;
    }
  }
}

/** @type {null | (() => object)} */
let depthGetHealthSnapshot = null;

async function main() {
  const app = Fastify({ logger: false });
  app.get("/health/mm", async () => {
    const h = /** @type {any} */ (health);
    const depthSnap =
      typeof depthGetHealthSnapshot === "function" ? depthGetHealthSnapshot() : null;
    const configured =
      depthSnap?.depthSubscribedConfigured ?? h.depthSubscribedTickers ?? 0;
    return {
      ok: h.lastOrchestratorError ? false : health.ok !== false,
      ...health,
      ...(depthSnap ?? {}),
      depthSubscribedTickers: configured,
      depthSubscribedConfigured: depthSnap?.depthSubscribedConfigured ?? configured,
      depthSubscribedConnected: depthSnap?.depthSubscribedConnected ?? 0,
      depthLastUpdateSecondsAgo:
        depthSnap?.depthLastUpdateSecondsAgo ?? h.depthLastUpdateSecondsAgo,
      depthTickersStale: depthSnap?.depthTickersStale ?? h.depthTickersStale,
    };
  });

  // Used by the daily ticker rotator to force a clean restart so the depth WS
  // re-subscribes to the freshly-enabled mm_market_config rows. Fly auto-restarts
  // the machine on process.exit.
  app.post("/admin/restart", async (req, reply) => {
    const adminKey = process.env.PMCI_ADMIN_KEY?.trim();
    if (adminKey && req.headers["x-pmci-admin-key"] !== adminKey) {
      return reply.code(403).send({ error: "forbidden", message: "admin key required" });
    }
    setTimeout(() => {
      console.error("[mm] /admin/restart invoked — exiting for Fly to respawn");
      process.exit(0);
    }, 500);
    return reply.code(202).send({ ok: true, restartingInMs: 500 });
  });

  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.error(`[mm] /health/mm listening on ${PORT}`);
  const t0 = new Date().toISOString();
  /** @type {any} */
  (health).startedAt = t0;
  /** @type {any} */
  (health).listenedAt = t0;

  /** @type {null | (() => void)} */
  let depthStop = null;
  const stopDepth = () => {
    if (depthStop) {
      try {
        depthStop();
      } catch {
        /* ignore */
      }
      depthStop = null;
    }
  };
  const onShutdown = () => {
    stopDepth();
    void app.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", onShutdown);
  process.once("SIGINT", onShutdown);

  const pg = createPgClient();
  await pg.connect();
  let enabled;
  try {
    enabled = await fetchEnabledMarketConfigs(pg);
  } finally {
    await pg.end().catch(() => {});
  }

  if (!enabled.length) {
    console.error(
      "[mm] depth: skipping startDepthIngestion — no rows in mm_market_config WHERE enabled=true (orchestrator loop still runs)",
    );
    /** @type {any} */
    (health).depthSubscribedTickers = 0;
    /** @type {any} */
    (health).depthSubscribedConfigured = 0;
    /** @type {any} */
    (health).depthSubscribedConnected = 0;
    /** @type {any} */
    (health).depthLastUpdateSecondsAgo = null;
    /** @type {any} */
    (health).depthTickersStale = null;
    /** @type {any} */
    (health).depthStartedAt = null;
  } else {
    const supabase = createServiceRoleSupabase();
    /** @type {import('pg').Client | null} */
    let depthPg = null;
    /** @type {undefined | ReturnType<typeof makePgDepthWriter>} */
    let depthWriteRow = undefined;
    if (!supabase) {
      try {
        depthPg = createPgClient();
        await depthPg.connect();
        depthWriteRow = makePgDepthWriter(depthPg, { logger: console });
        console.error(
          "[mm] depth: SUPABASE_SERVICE_ROLE_KEY unset — using DATABASE_URL for provider_market_depth inserts",
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[mm] depth: cannot open DATABASE_URL for depth writes:", msg);
        /** @type {any} */
        (health).depthStartError = `depth: set SUPABASE_SERVICE_ROLE_KEY or fix DATABASE_URL (${msg})`;
      }
    }

    if (supabase || depthWriteRow) {
      const wsUrl = resolveKalshiDemoDepthWsUrl();
      const keyId = process.env.KALSHI_DEMO_API_KEY_ID ?? process.env.KALSHI_API_KEY_ID;
      const pemPath = process.env.KALSHI_DEMO_PRIVATE_KEY_PATH;
      const pemInline = process.env.KALSHI_DEMO_PRIVATE_KEY;
      const marketTickers = enabled.map((r) => String(r.kalshi_ticker));
      const tickerToProviderMarketId = new Map(
        enabled.map((r) => [String(r.kalshi_ticker), r.market_id]),
      );
      /** @type {any} */
      (health).depthSubscribedConfigured = marketTickers.length;
      /** @type {any} */
      (health).depthSubscribedTickers = marketTickers.length;

      // Caveat-3 fix: retry indefinitely in the background so a flaky first
      // handshake (DNS / TLS / Kalshi WS reload) doesn't leave the runtime
      // permanently depth-less. The orchestrator loop kicks off below in parallel.
      void (async () => {
        if (!keyId?.trim()) {
          /** @type {any} */
          (health).depthStartError =
            "KALSHI_DEMO_API_KEY_ID (or KALSHI_API_KEY_ID) required for depth";
          return;
        }
        let privateKey;
        try {
          privateKey = loadPrivateKey({ path: pemPath, inline: pemInline });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          /** @type {any} */
          (health).depthStartError = `loadPrivateKey failed: ${msg}`;
          return;
        }
        console.error(
          `[mm] depth: starting ingestion for ${marketTickers.length} ticker(s) ws=${wsUrl} (retry-on-fail)`,
        );
        const { stop: stopInner, getHealthSnapshot } = await startDepthWithRetry(
          () =>
            startDepthIngestion({
              marketTickers,
              tickerToProviderMarketId,
              wsUrl,
              apiKeyId: String(keyId),
              privateKey,
              supabase: supabase ?? undefined,
              writeRow: depthWriteRow,
              downsampleIntervalMs: 1000,
              logger: console,
            }),
          ({ attempt, nextDelayMs, error }) => {
            const msg = error?.message ?? String(error);
            console.error(
              `[mm] depth: start attempt ${attempt} failed (${msg}); retrying in ${nextDelayMs}ms`,
            );
            /** @type {any} */
            (health).depthStartAttempts = attempt;
            /** @type {any} */
            (health).depthStartLastAttemptAt = new Date().toISOString();
            /** @type {any} */
            (health).depthStartError = msg;
          },
        );
        depthGetHealthSnapshot = getHealthSnapshot;
        depthStop = () => {
          depthGetHealthSnapshot = null;
          stopInner();
          if (depthPg) {
            void depthPg.end().catch(() => {});
            depthPg = null;
          }
        };
        const started = new Date().toISOString();
        /** @type {any} */
        (health).depthStartedAt = started;
        /** @type {any} */
        (health).depthStartError = null;
      })();
    }
  }

  runMmOrchestratorLoop({ health: /** @type {any} */ (health) }).catch((e) => {
    console.error("[mm] orchestrator stopped", e);
    health.ok = false;
    /** @type {any} */
    (health).lastOrchestratorError = e instanceof Error ? e.message : String(e);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
