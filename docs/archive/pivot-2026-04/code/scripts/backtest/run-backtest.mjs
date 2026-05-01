#!/usr/bin/env node
/**
 * A5 — backtest: per-template scoreboard + per-fixture audit + meta sidecar.
 * See docs/pivot/agents/a5-backtest-engine.md and docs/pivot/success-rubric.md.
 *
 * Writes three artifacts at fixed paths:
 *   docs/pivot/artifacts/a5-backtest-templates-latest.csv  (scoreboard)
 *   docs/pivot/artifacts/a5-backtest-fixtures-latest.csv   (audit trail)
 *   docs/pivot/artifacts/a5-backtest-meta.json             (run metadata)
 *
 * Snapshot source of truth: pmci.provider_market_snapshots.
 *
 * Usage:
 *   node scripts/backtest/run-backtest.mjs [--a3 path] [--include-ambiguous] [--interval-hours N]
 *   PMCI_BACKTEST_USE_STUB=1   — dev banner; stub cost path is no longer wired to the arb engine,
 *                                so this flag simply prints a warning in the v1 refactor.
 *   PMCI_ENTRY_THRESHOLD_ABS=0.01 — override default entry threshold.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";
import { defaultA3Path, loadEquivalenceCsv } from "../../lib/backtest/equivalence-csv.mjs";
import {
  runBacktestEngine,
  DEFAULT_ENTRY_THRESHOLD,
  ENGINE_VERSION,
} from "../../lib/backtest/run-engine.mjs";
import { aggregateByTemplate, round2, round4 } from "../../lib/backtest/aggregate.mjs";

const TEMPLATE_DEFINITION_VERSION = "sports-v1";
const COST_MODEL_VERSION = "v1";
const VOID_REFUND_MODEL = "full_refund_v1";
const PREMIUM_PER_TRADE_USD = 100;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "../..");
loadEnv();

const ARTIFACTS_DIR = path.join(REPO, "docs/pivot/artifacts");
const TEMPLATES_CSV_PATH = path.join(ARTIFACTS_DIR, "a5-backtest-templates-latest.csv");
const FIXTURES_CSV_PATH = path.join(ARTIFACTS_DIR, "a5-backtest-fixtures-latest.csv");
const META_JSON_PATH = path.join(ARTIFACTS_DIR, "a5-backtest-meta.json");

function parseArgs(argv) {
  const o = { includeAmbiguous: false, a3: defaultA3Path(REPO), intervalHours: 1 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--a3" && argv[i + 1]) {
      o.a3 = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--include-ambiguous") o.includeAmbiguous = true;
    else if (argv[i] === "--interval-hours" && argv[i + 1]) {
      o.intervalHours = Math.max(1, parseInt(argv[i + 1], 10) || 1);
      i += 1;
    } else if (argv[i] === "--out" && argv[i + 1]) {
      process.stderr.write(
        "[pmci backtest] --out is deprecated in the arb-v1 refactor; artifacts are written to fixed paths under docs/pivot/artifacts/. Ignoring.\n",
      );
      i += 1;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      o.help = true;
    }
  }
  return o;
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsvLine(cols) {
  return cols.map(csvEscape).join(",");
}

/**
 * Format a number for CSV emission deterministically. Undefined / null → ''.
 * Whole numbers without a fraction keep integer format; fractional numbers
 * render as the shortest round-tripping decimal (JS default toString suffices
 * after Math.round scaling applied upstream).
 */
function formatNum(v) {
  if (v == null) return "";
  if (typeof v === "number" && !Number.isFinite(v)) return "";
  return String(v);
}

const FIXTURES_COLUMNS = [
  "family_id",
  "template_id",
  "template_label",
  "category",
  "sport",
  "resolution_equivalence",
  "skip",
  "direction",
  "spread_at_entry",
  "cheap_state",
  "exp_state",
  "gross_dollars",
  "net_dollars",
  "hold_days",
  "entry_threshold_used",
  "snapshot_interval_ms",
  "void_refund_model",
];

const TEMPLATES_COLUMNS = [
  "template_id",
  "template_label",
  "category",
  "trades_simulated",
  "win_rate",
  "mean_net_edge_per_100",
  "total_pnl_history",
  "median_hold_days",
  "disagreement_rate",
  "void_rate",
  "resolution_equivalence",
];

function serializeFixtureRow(r) {
  // Sort key happens at the caller; this only serializes a single row.
  return toCsvLine(
    FIXTURES_COLUMNS.map((c) => {
      const v = r[c];
      if (c === "gross_dollars" || c === "net_dollars") {
        return v == null ? "" : formatNum(round2(Number(v)));
      }
      if (c === "spread_at_entry") {
        return v == null ? "" : formatNum(Number(v));
      }
      if (c === "hold_days" || c === "snapshot_interval_ms") {
        return v == null ? "" : formatNum(Number(v));
      }
      if (c === "entry_threshold_used") {
        return v == null ? "" : formatNum(Number(v));
      }
      return v == null ? "" : String(v);
    }),
  );
}

export function serializeFixturesCsv(fixtureRows) {
  const sorted = fixtureRows.slice().sort((a, b) => {
    const t = String(a.template_id).localeCompare(String(b.template_id));
    if (t !== 0) return t;
    return String(a.family_id).localeCompare(String(b.family_id), "en", { numeric: true });
  });
  const lines = [toCsvLine(FIXTURES_COLUMNS)];
  for (const r of sorted) lines.push(serializeFixtureRow(r));
  return lines.join("\n") + "\n";
}

export function serializeTemplatesCsv(templateAggregates) {
  const lines = [toCsvLine(TEMPLATES_COLUMNS)];
  for (const r of templateAggregates) {
    lines.push(
      toCsvLine(
        TEMPLATES_COLUMNS.map((c) => {
          const v = r[c];
          if (
            c === "mean_net_edge_per_100" ||
            c === "total_pnl_history"
          ) {
            return v == null ? "" : formatNum(round2(Number(v)));
          }
          if (c === "win_rate" || c === "disagreement_rate" || c === "void_rate") {
            return v == null ? "" : formatNum(round4(Number(v)));
          }
          if (c === "trades_simulated" || c === "median_hold_days") {
            return v == null ? "" : formatNum(Number(v));
          }
          return v == null ? "" : String(v);
        }),
      ),
    );
  }
  return lines.join("\n") + "\n";
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function fileSha256Hex(filePath) {
  return sha256Hex(fs.readFileSync(filePath));
}

function tryGitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      `node scripts/backtest/run-backtest.mjs [--a3 path] [--include-ambiguous] [--interval-hours N]\n` +
        `Artifacts are written to fixed paths under docs/pivot/artifacts/.`,
    );
    process.exit(0);
  }

  const useStub = process.env.PMCI_BACKTEST_USE_STUB === "1";
  if (useStub) {
    console.error(
      "[pmci backtest] PMCI_BACKTEST_USE_STUB=1: stub cost path is no longer wired in the arb-v1 refactor. The real cost model from lib/execution/costs.mjs is in use. Not a scoreboard-gating concern.",
    );
  }

  if (args.includeAmbiguous) {
    console.error(
      "[pmci backtest] --include-ambiguous: A3 'ambiguous' families included. Dev/scaffold only — do not treat output as a final scoreboard run.",
    );
  }

  if (!fs.existsSync(args.a3)) {
    console.error(`[pmci backtest] A3 file not found: ${args.a3}`);
    process.exit(1);
  }

  const excludeFamily = new Set(["3130"]);
  const { byFamily, warnings } = loadEquivalenceCsv(args.a3, {
    allowAmbiguous: args.includeAmbiguous,
    excludeFamilyIds: excludeFamily,
  });
  for (const w of warnings) console.error(`[pmci backtest] warn: ${w}`);

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const intervalMs = args.intervalHours * 60 * 60 * 1000;
  const entryThresholdAbs = Number(
    process.env.PMCI_ENTRY_THRESHOLD_ABS || String(DEFAULT_ENTRY_THRESHOLD),
  );
  const client = new pg.Client({ connectionString: url });
  (async () => {
    await client.connect();
    try {
      const { rows, config } = await runBacktestEngine({
        pg: client,
        a3ByFamily: byFamily,
        intervalMs,
        entryThresholdAbs,
        excludeFamilyIds: excludeFamily,
      });

      if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

      // 1. Fixtures CSV (audit trail).
      const fixturesCsv = serializeFixturesCsv(rows);
      fs.writeFileSync(FIXTURES_CSV_PATH, fixturesCsv, { encoding: "utf8" });

      // 2. Templates CSV (scoreboard).
      const templateAggregates = aggregateByTemplate(rows);
      const templatesCsv = serializeTemplatesCsv(templateAggregates);
      fs.writeFileSync(TEMPLATES_CSV_PATH, templatesCsv, { encoding: "utf8" });

      // 3. Meta JSON (after both CSVs are on disk, so SHA-256 matches what's read back).
      const a3Sha = fileSha256Hex(args.a3);
      const fixturesSha = fileSha256Hex(FIXTURES_CSV_PATH);
      const templatesSha = fileSha256Hex(TEMPLATES_CSV_PATH);
      const settledFamilyCount = rows.filter((r) => r.skip !== "outcomes_missing").length;
      const totalFamilyCount = rows.length;
      const meta = {
        created_at: new Date().toISOString(),
        git_sha: tryGitSha(),
        engine_version: ENGINE_VERSION,
        cost_model_version: COST_MODEL_VERSION,
        template_definition_version: TEMPLATE_DEFINITION_VERSION,
        entry_threshold_abs: entryThresholdAbs,
        interval_ms: intervalMs,
        premium_per_trade_usd: PREMIUM_PER_TRADE_USD,
        void_refund_model: VOID_REFUND_MODEL,
        a3_csv_path: path.relative(REPO, args.a3),
        a3_csv_sha256: a3Sha,
        settled_family_count: settledFamilyCount,
        total_family_count: totalFamilyCount,
        templates_csv_sha256: templatesSha,
        fixtures_csv_sha256: fixturesSha,
        engine_config: config,
      };
      fs.writeFileSync(META_JSON_PATH, JSON.stringify(meta, null, 2) + "\n", { encoding: "utf8" });

      process.stderr.write(
        `[pmci backtest] Wrote ${rows.length} fixture rows and ${templateAggregates.length} template rows.\n` +
          `  templates: ${path.relative(REPO, TEMPLATES_CSV_PATH)}\n` +
          `  fixtures:  ${path.relative(REPO, FIXTURES_CSV_PATH)}\n` +
          `  meta:      ${path.relative(REPO, META_JSON_PATH)}\n`,
      );
      if (byFamily.size === 0) {
        process.stderr.write(
          "[pmci backtest] No families in A3 map after filter — 0 rows. Use --include-ambiguous to scaffold, or wait for A3 final classifications.\n",
        );
      }
    } finally {
      await client.end();
    }
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

// Only run main() when invoked as a script. When imported (e.g., from tests),
// the exported serializers are what matters.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
