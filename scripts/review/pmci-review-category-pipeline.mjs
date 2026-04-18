#!/usr/bin/env node
/**
 * Runs propose → auto-accept → audit for crypto or economics (same as npm run pmci:review:*).
 * Used by admin-jobs / pg_cron so scheduled review runs the full gated pipeline.
 */
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function runNode(rel, extraArgs = []) {
  const script = join(root, rel);
  const r = spawnSync(process.execPath, [script, ...extraArgs], {
    stdio: "inherit",
    env: process.env,
    cwd: root,
  });
  if (r.status !== 0 && r.status != null) process.exit(r.status);
  if (r.error) throw r.error;
}

const economics = process.argv.includes("--economics");
if (economics) {
  runNode("scripts/review/pmci-propose-links-economics.mjs");
  runNode("scripts/review/pmci-auto-accept.mjs");
  runNode("scripts/review/pmci-auto-accept-audit.mjs");
} else {
  runNode("scripts/review/pmci-propose-links-crypto.mjs");
  runNode("scripts/review/pmci-auto-accept.mjs");
  runNode("scripts/review/pmci-auto-accept-audit.mjs");
}
