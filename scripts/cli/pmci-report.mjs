#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createPgClient } from "../../lib/mm/order-store.mjs";
import { writeDailyReport } from "../../lib/scanner/daily-report-render.mjs";
import { getReportsRoot } from "../../lib/scanner/report-paths.mjs";
import { writeWeeklyDigest } from "../../lib/scanner/weekly-digest-render.mjs";
import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

function pickArg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

async function daily() {
  const date = pickArg("--date");
  const conn = createPgClient();
  await conn.connect();
  try {
    const out = await writeDailyReport({ client: conn, dateStamp: date });
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await conn.end().catch(() => {});
  }
}

async function weekly() {
  const week = pickArg("--week");
  const conn = createPgClient();
  await conn.connect();
  try {
    const out = await writeWeeklyDigest({
      client: conn,
      weekStamp: week,
      skipAutoRetire: process.argv.includes("--skip-auto-retire"),
    });
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await conn.end().catch(() => {});
  }
}

async function dashboard() {
  const port = Number(pickArg("--port") ?? "8080");
  const root = getReportsRoot();

  async function indexHtml() {
    const dailyDir = path.join(root, "daily");
    const weeklyDir = path.join(root, "weekly");
    let dailyLinks = "";
    let weeklyLinks = "";
    try {
      for (const f of await fs.readdir(dailyDir)) {
        if (!f.endsWith(".html")) continue;
        dailyLinks += `<li><a href="./daily/${encodeURIComponent(f)}">${f}</a></li>`;
      }
    } catch {
      dailyLinks += "<li class=muted>No daily artefacts yet.</li>";
    }
    try {
      for (const f of await fs.readdir(weeklyDir)) {
        if (!f.endsWith(".html")) continue;
        weeklyLinks += `<li><a href="./weekly/${encodeURIComponent(f)}">${f}</a></li>`;
      }
    } catch {
      weeklyLinks += "<li class=muted>No weekly artefacts yet.</li>";
    }

    const ts = new Date().toISOString();
    return `<!DOCTYPE html><html><head><meta charset=utf-8><title>Reports</title>
    <style>body{font-family:system-ui;} .muted{color:#666;} code{background:#eee;padding:2px}</style></head><body>
    <p class=muted>PMCI_REPORTS_LOCAL_DIR=<code>${root}</code></p>
    <h2>Daily</h2><ul>${dailyLinks || "<li class=muted>empty</li>"}</ul>
    <h2>Weekly</h2><ul>${weeklyLinks || "<li class=muted>empty</li>"}</ul>
    <p class=muted>Refreshed at ${ts} (poll reload)</p></body></html>`;
  }

  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (req.method !== "GET") {
      res.writeHead(405);
      return res.end();
    }
    try {
      if (u.pathname === "/" || u.pathname === "/dashboard") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Refresh": "60" });
        return res.end(await indexHtml());
      }
      if (u.pathname.startsWith("/daily/")) {
        const bn = path.basename(u.pathname.slice("/daily/".length));
        const fp = path.join(root, "daily", bn);
        const buf = await fs.readFile(fp, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(buf);
      }
      if (u.pathname.startsWith("/weekly/")) {
        const bn = path.basename(u.pathname.slice("/weekly/".length));
        const fp = path.join(root, "weekly", bn);
        const buf = await fs.readFile(fp, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(buf);
      }
      res.writeHead(404);
      res.end();
    } catch {
      res.writeHead(404);
      res.end();
    }
  });

  srv.listen(port, () => {
    console.log(`dashboard http://127.0.0.1:${port}/dashboard (auto-refresh 60s)`);
  });
}

const cmd = process.argv[2];
if (cmd === "daily") await daily();
else if (cmd === "weekly") await weekly();
else if (cmd === "dashboard") await dashboard();
else {
  console.log(`usage:

  pmci-report daily [--date YYYY-MM-DD]
  pmci-report weekly [--week YYYY-Www] [--skip-auto-retire]
  pmci-report dashboard [--port 8080]
`);
  process.exit(cmd ? 2 : 0);
}
