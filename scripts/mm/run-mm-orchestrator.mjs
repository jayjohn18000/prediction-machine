#!/usr/bin/env node
/**
 * W3 MM orchestrator — fair → quote → DEMO Kalshi.
 * Env: DATABASE_URL, KALSHI_DEMO_* keys, KALSHI_BASE (default DEMO), MM_DURATION_MS (default 60000), MM_TICK_MS (default 5000).
 */

import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

import { runMmOrchestratorLoop } from "../../lib/mm/orchestrator.mjs";

async function main() {
  console.log("[mm] orchestrator start", new Date().toISOString());
  const lines = await runMmOrchestratorLoop({
    durationMs: Number(process.env.MM_DURATION_MS ?? 60_000),
    intervalMs: Number(process.env.MM_TICK_MS ?? 5000),
  });
  console.log("[mm] orchestrator stopped line_count=", lines.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
