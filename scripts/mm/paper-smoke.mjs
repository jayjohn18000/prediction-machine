#!/usr/bin/env node
/**
 * Paper-mode smoke harness (Stream D): live Kalshi WS/REST, DB paper orders only.
 *
 * Usage:
 *   MM_RUN_MODE=paper MM_PAPER_MODE_ENABLED=true DATABASE_URL=... KALSHI_PROD_*=... \
 *     node scripts/mm/paper-smoke.mjs --duration=2h
 */

import { loadEnv } from "../../src/platform/env.mjs";
loadEnv();

import { mkdirSync, createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  resolveKalshiRunMode,
  isPaperModeEnabledFromEnv,
} from "../../lib/mm/kalshi-env.mjs";
import { runMmOrchestratorLoop } from "../../lib/mm/orchestrator.mjs";

const __d = dirname(fileURLToPath(import.meta.url));
const outDir = join(__d, "paper-smoke-output");
mkdirSync(outDir, { recursive: true });

function parseDurationMs(argv) {
  const j = argv.findIndex((a) => a.startsWith("--duration="));
  if (j >= 0) {
    const raw = argv[j].slice("--duration=".length).trim();
    if (/^\d+h$/i.test(raw)) return Number(raw.slice(0, -1)) * 3600_000;
    if (/^\d+m$/i.test(raw)) return Number(raw.slice(0, -1)) * 60_000;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return 7200_000;
}

async function main() {
  if (resolveKalshiRunMode() !== "paper") {
    console.error("paper-smoke: set MM_RUN_MODE=paper");
    process.exit(2);
  }
  if (!isPaperModeEnabledFromEnv()) {
    console.error("paper-smoke: set MM_PAPER_MODE_ENABLED=true");
    process.exit(2);
  }

  const durationMs = parseDurationMs(process.argv);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonl = join(outDir, `${ts}.jsonl`);
  const sink = createWriteStream(jsonl, { flags: "a" });

  /** @type {{ vpin: number, game: number, iprot: number, paper: number, exc: number, ticks: number }} */
  const counts = { vpin: 0, game: 0, iprot: 0, paper: 0, exc: 0, ticks: 0 };

  const origLog = console.log.bind(console);
  console.log = (...args) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    if (line.includes("vpin_pull")) counts.vpin += 1;
    if (line.includes("game_state_pull")) counts.game += 1;
    if (line.includes("budget_skip")) counts.iprot += 1;
    if (line.includes("paper-") && (line.includes(" bid ") || line.includes(" ask "))) counts.paper += 1;
    try {
      sink.write(JSON.stringify({ t: Date.now(), line }) + "\n");
    } catch {
      /* stream may be closed */
    }
    origLog(...args);
  };

  process.once("unhandledRejection", (e) => {
    counts.exc += 1;
    console.error("paper-smoke unhandledRejection", e);
  });
  process.once("uncaughtException", (e) => {
    counts.exc += 1;
    console.error("paper-smoke uncaughtException", e);
  });

  const t0 = Date.now();
  try {
    await runMmOrchestratorLoop({
      durationMs,
      health: {
        loopTick: 0,
        lastMainLoopTickAt: null,
        lastSessionLineCount: 0,
      },
    });
  } catch (e) {
    counts.exc += 1;
    console.error("paper-smoke loop error", e);
  } finally {
    console.log = origLog;
    await new Promise((res) => {
      sink.end(() => res());
    });
  }
  counts.ticks = Math.floor((Date.now() - t0) / 5000);
  origLog(
    JSON.stringify({
      event: "paper_smoke_summary",
      durationMs,
      jsonl,
      counts,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
