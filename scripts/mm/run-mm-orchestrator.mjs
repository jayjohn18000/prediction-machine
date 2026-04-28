#!/usr/bin/env node
/**
 * MM orchestrator runtime: HTTP /health/mm + reconcile + main quoting loop (W4).
 * Env: PORT (default 8790), DATABASE_URL, KALSHI_DEMO_* , MM_DURATION_MS empty = run forever,
 * MM_TICK_MS (default 5000).
 */

import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

import Fastify from "fastify";
import { runMmOrchestratorLoop } from "../../lib/mm/orchestrator.mjs";

const PORT = Number(process.env.PORT ?? 8790);

/** @type {Record<string, unknown>} */
const health = {
  ok: true,
  role: "mm-runtime",
  startedAt: null,
  lastReconcileAt: null,
  reconcilePhase: null,
  reconcileSkipped: null,
  lastMainLoopTickAt: null,
  loopTick: 0,
  lastSessionLineCount: 0,
};

async function main() {
  const app = Fastify({ logger: false });
  app.get("/health/mm", async () => ({
    ok: health.ok !== false,
    ...health,
  }));

  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.error(`[mm] /health/mm listening on ${PORT}`);
  /** @type {any} */
  (health).startedAt = new Date().toISOString();

  await runMmOrchestratorLoop({ health: /** @type {any} */ (health) });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
