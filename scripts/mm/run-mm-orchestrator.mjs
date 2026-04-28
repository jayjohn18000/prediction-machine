#!/usr/bin/env node
/**
 * MM orchestrator runtime: HTTP /health/mm + Kalshi L2 depth (W1) + reconcile + main quoting loop (W4).
 * Env: PORT (default 8790), DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (for depth writes),
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
import { startDepthIngestion } from "../../lib/ingestion/depth.mjs";

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
  depthSubscribedTickers: 0,
  depthStartedAt: null,
  depthStartError: null,
};

async function main() {
  const app = Fastify({ logger: false });
  app.get("/health/mm", async () => ({
    ok: /** @type {any} */ (health).lastOrchestratorError ? false : health.ok !== false,
    ...health,
  }));

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
    (health).depthStartedAt = null;
  } else {
    const supabase = createServiceRoleSupabase();
    if (!supabase) {
      const msg =
        "depth: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required to write provider_market_depth";
      console.error(`[mm] ${msg}`);
      /** @type {any} */
      (health).depthStartError = msg;
    } else {
      const wsUrl = resolveKalshiDemoDepthWsUrl();
      const keyId = process.env.KALSHI_DEMO_API_KEY_ID ?? process.env.KALSHI_API_KEY_ID;
      const pemPath = process.env.KALSHI_DEMO_PRIVATE_KEY_PATH;
      const pemInline = process.env.KALSHI_DEMO_PRIVATE_KEY;
      try {
        if (!keyId?.trim()) throw new Error("KALSHI_DEMO_API_KEY_ID (or KALSHI_API_KEY_ID) required for depth");
        const privateKey = loadPrivateKey({ path: pemPath, inline: pemInline });
        const marketTickers = enabled.map((r) => String(r.kalshi_ticker));
        const tickerToProviderMarketId = new Map(
          enabled.map((r) => [String(r.kalshi_ticker), r.market_id]),
        );
        console.error(
          `[mm] depth: starting ingestion for ${marketTickers.length} ticker(s) ws=${wsUrl}`,
        );
        const { stop } = await startDepthIngestion({
          marketTickers,
          tickerToProviderMarketId,
          wsUrl,
          apiKeyId: String(keyId),
          privateKey,
          supabase,
          downsampleIntervalMs: 1000,
          logger: console,
        });
        depthStop = stop;
        const started = new Date().toISOString();
        /** @type {any} */
        (health).depthSubscribedTickers = marketTickers.length;
        /** @type {any} */
        (health).depthStartedAt = started;
        /** @type {any} */
        (health).depthStartError = null;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[mm] depth: startDepthIngestion failed:", msg);
        /** @type {any} */
        (health).depthStartError = msg;
        /** @type {any} */
        (health).depthSubscribedTickers = 0;
        /** @type {any} */
        (health).depthStartedAt = null;
      }
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
