#!/usr/bin/env node
/**
 * Stream E — replay backtest CLI (see `.cursor-prompts/phase-0/05-stream-e-backtest-engine.md`).
 */
import "dotenv/config";
import { createPgClient } from "../../lib/mm/order-store.mjs";
import { runBacktest } from "../../lib/backtest/engine.mjs";

function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--compare-live") {
      o.compareLive = true;
      continue;
    }
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[++i];
      if (v == null || v.startsWith("--")) {
        i--;
        o[k] = true;
      } else o[k] = v;
    }
  }
  return o;
}

/**
 * @param {import('pg').Client} client
 * @param {string} hypothesisId
 */
async function compareBacktestVsLive(client, hypothesisId) {
  const col = await client.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'pmci'
      AND table_name = 'mm_pnl_snapshots'
      AND column_name = ANY ($1::text[])
    `,
    [["hypothesis_id", "mode"]],
  );
  const have = new Set((col.rows ?? []).map((r) => r.column_name));
  if (!have.has("hypothesis_id")) {
    return {
      ok: false,
      reason: "mm_pnl_snapshots lacks hypothesis_id (apply Stream A migration)",
    };
  }
  const modeClause = have.has("mode") ? "AND mode = 'live'" : "";
  const live = await client.query(
    `
    SELECT
      coalesce(avg(spread_capture_cents), 0)::numeric AS avg_spread_capture,
      coalesce(avg(adverse_selection_cents), 0)::numeric AS avg_adverse
    FROM pmci.mm_pnl_snapshots
    WHERE hypothesis_id = $1::text
      ${modeClause}
    `,
    [hypothesisId],
  );
  const bt = await client.query(
    `
    SELECT
      coalesce(avg(spread_capture_c), 0)::numeric AS avg_spread_capture,
      coalesce(avg(adverse_c), 0)::numeric AS avg_adverse,
      coalesce(avg(fill_rate), 0)::numeric AS avg_fill_rate
    FROM pmci.backtest_runs
    WHERE hypothesis_id = $1::text
    `,
    [hypothesisId],
  );
  const l = live.rows[0] ?? {};
  const b = bt.rows[0] ?? {};
  const lSc = Number(l.avg_spread_capture);
  const bSc = Number(b.avg_spread_capture);
  let within30 = null;
  if (Number.isFinite(lSc) && lSc !== 0 && Number.isFinite(bSc)) {
    within30 = Math.abs(bSc - lSc) / Math.abs(lSc) < 0.3;
  }
  return {
    ok: true,
    live: { avg_spread_capture: lSc, avg_adverse: Number(l.avg_adverse) },
    backtestRuns: {
      avg_spread_capture: bSc,
      avg_adverse: Number(b.avg_adverse),
      avg_fill_rate: Number(b.avg_fill_rate),
    },
    spreadCaptureGapRatio:
      Number.isFinite(lSc) && lSc !== 0 ? Math.abs(bSc - lSc) / Math.abs(lSc) : null,
    within30Pct: within30,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const hypothesis = String(args.hypothesis ?? "");
  const start = String(args.start ?? "");
  const end = String(args.end ?? "");
  const market = String(args.market ?? "");
  if (!hypothesis || !start || !end || !market) {
    console.error(
      "Usage: node scripts/backtest/run-backtest.mjs --hypothesis <id> --start <iso> --end <iso> --market <kalshi_ticker> [--compare-live]\n",
    );
    process.exit(2);
  }

  const out = await runBacktest({ hypothesisId: hypothesis, marketTicker: market, startAt: start, endAt: end });
  console.log(JSON.stringify(out, null, 2));

  if (args.compareLive) {
    const client = createPgClient();
    await client.connect();
    try {
      const cmp = await compareBacktestVsLive(client, hypothesis);
      console.log("\n-- compare-live --\n", JSON.stringify(cmp, null, 2));
    } finally {
      await client.end().catch(() => {});
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
