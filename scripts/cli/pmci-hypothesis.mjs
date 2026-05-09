#!/usr/bin/env node
/**
 * Hypothesis lifecycle CLI — Stream F.
 *
 * DATABASE_URL required. Tables are Stream A artefacts.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createPgClient } from "../../lib/mm/order-store.mjs";
import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

function fmtRows(rows, cols) {
  if (!rows.length) return "(empty)";
  const w = cols.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => String(r[cols[i]] ?? "").length)),
  );
  const line = (r) =>
    cols.map((c, j) => String(r[c] ?? "").padEnd(w[j])).join(" | ");
  return [line(Object.fromEntries(cols.map((c) => [c, c]))), ...rows.map(line)].join("\n");
}

function arg(i) {
  return process.argv[i];
}

async function auditLog(conn, hypoId, fromS, toS, reason, actor = "cli") {
  await conn.query(
    `INSERT INTO pmci.hypothesis_state_log
       (hypothesis_id, from_status, to_status, reason, actor)
     VALUES ($1, $2, $3, $4, $5)`,
    [hypoId, fromS, toS, reason, actor],
  );
}

async function cmdList(conn) {
  const statusIdx = process.argv.indexOf("--status");
  const status = statusIdx !== -1 ? process.argv[statusIdx + 1] : undefined;
  const q = status
    ? conn.query(
        `SELECT id::text, status::text, created_at FROM pmci.hypotheses WHERE status::text = $1 ORDER BY created_at DESC`,
        [status],
      )
    : conn.query(
        `SELECT id::text, status::text, created_at FROM pmci.hypotheses ORDER BY created_at DESC LIMIT 80`,
      );
  const rows = (await q).rows;
  console.log(fmtRows(rows, ["id", "status", "created_at"]));
}

async function cmdShow(conn, id) {
  const hi = await conn.query(
    `SELECT row_to_json(t.*)::json AS j FROM pmci.hypotheses t WHERE id::text = $1`,
    [id],
  );
  console.log("hypothesis:\n", JSON.stringify(hi.rows[0]?.j ?? null, null, 2));
  const sg = await conn.query(
    `SELECT signal_type::text, score, observed_at, payload
       FROM pmci.scanner_signals_unified
       WHERE hypothesis_id::text = $1
       ORDER BY observed_at DESC NULLS LAST LIMIT 50`,
    [id],
  );
  console.log("\nsignals (50):\n", JSON.stringify(sg.rows, null, 2));
}

async function cmdDecay(conn, id) {
  const r = await conn.query(
    `SELECT row_to_json(t.*)::json AS j FROM pmci.hypothesis_decay_state t WHERE hypothesis_id::text = $1`,
    [id],
  );
  console.log(JSON.stringify(r.rows[0]?.j ?? null, null, 2));
}

async function cmdStages(conn, id) {
  try {
    const staged = await conn.query(
      `SELECT stage::text, count(*)::int AS n
         FROM pmci.scanner_stage_compare
         WHERE hypothesis_id::text = $1
         GROUP BY stage
         ORDER BY stage`,
      [id],
    );
    if (staged.rows.length) {
      console.log(fmtRows(staged.rows, ["stage", "n"]));
      return;
    }
  } catch {
    /* view missing */
  }
  console.warn(
    "[pmci-hypothesis stages] pmci.scanner_stage_compare unavailable or empty — wire Stream B/C SQL when ready.",
  );
}

async function cmdPromote(conn, id) {
  const toIdx = process.argv.indexOf("--to");
  if (toIdx === -1) throw new Error("promote requires --to <status>");
  const toS = process.argv[toIdx + 1];
  const before = await conn.query(
    `SELECT status::text AS s FROM pmci.hypotheses WHERE id::text = $1`,
    [id],
  );
  const fromS = before.rows[0]?.s;
  if (!fromS) throw new Error("hypothesis missing");
  await conn.query(`UPDATE pmci.hypotheses SET status = $2 WHERE id::text = $1`, [id, toS]);
  await auditLog(conn, id, fromS, toS, "manual promote via pmci-hypothesis", "cli");
  console.log(JSON.stringify({ ok: true, from: fromS, to: toS }));
}

async function cmdRetire(conn, id) {
  const rIdx = process.argv.indexOf("--reason");
  if (rIdx === -1) throw new Error("retire requires --reason <text>");
  const rest = process.argv.slice(rIdx + 1);
  const reasonParts = [];
  for (const p of rest) {
    if (p.startsWith("--")) break;
    reasonParts.push(p);
  }
  const reason = reasonParts.join(" ").trim() || "(no reason text)";
  const before = await conn.query(
    `SELECT status::text AS s FROM pmci.hypotheses WHERE id::text = $1`,
    [id],
  );
  const fromS = before.rows[0]?.s;
  if (!fromS) throw new Error("hypothesis missing");
  await conn.query(
    `UPDATE pmci.hypotheses
     SET status = 'retired', retired_reason = $2,
         retired_at = COALESCE(retired_at, now())
     WHERE id::text = $1`,
    [id, reason],
  );
  await auditLog(conn, id, fromS, "retired", reason, "cli");
  console.log(JSON.stringify({ ok: true, from: fromS, to: "retired", reason }));
}

async function cmdBacktest(id, daysStr) {
  const script = path.join(process.cwd(), "scripts/backtest/run-backtest.mjs");
  await fs.access(script).catch(() => {
    throw new Error("missing scripts/backtest/run-backtest.mjs");
  });
  const child = spawn(
    process.execPath,
    [script, "--hypothesis-id", id, "--days", daysStr],
    { stdio: "inherit" },
  );
  await new Promise((resolve, reject) => {
    child.on("exit", (c) =>
      c === 0 ? resolve() : reject(new Error(`exit ${String(c ?? "")}`)));
  });
}

async function main() {
  const verb = arg(2);
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL required");
    process.exit(2);
  }
  if (!verb || verb === "help" || verb === "-h") {
    console.log(`
pmci-hypothesis <cmd> ...

  list [--status live]
  show <id>
  promote <id> --to <status>
  retire <id> --reason ...
  decay <id>
  stages <id>
  backtest <id> --days N
`);
    return;
  }

  if (verb === "backtest") {
    const dIdx = process.argv.indexOf("--days");
    const days =
      dIdx !== -1 && process.argv[dIdx + 1] ? process.argv[dIdx + 1] : "30";
    await cmdBacktest(arg(3), days);
    return;
  }

  const conn = createPgClient();
  await conn.connect();
  try {
    if (verb === "list") return await cmdList(conn);
    if (verb === "show") return await cmdShow(conn, arg(3));
    if (verb === "decay") return await cmdDecay(conn, arg(3));
    if (verb === "stages") return await cmdStages(conn, arg(3));
    if (verb === "promote") return await cmdPromote(conn, arg(3));
    if (verb === "retire") return await cmdRetire(conn, arg(3));
    throw new Error(`unknown command '${verb}'`);
  } finally {
    await conn.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
