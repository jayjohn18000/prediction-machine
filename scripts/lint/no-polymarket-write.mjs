#!/usr/bin/env node
/**
 * Pre-W1 P1 — refuse accidental trading / CLOB write paths in non-whitelisted code.
 * Intended for `npm test` / CI (see package.json: `lint:poly-write-guard`).
 *
 * Scans `lib/`, `src/`, `scripts/` (not `test/`). Fails if a file uses an HTTP
 * stack AND references blocked Polymarket endpoints outside allowlisted modules.
 *
 * Legacy GET-only readers (resolution/backfill against CLOB) remain allowlisted so
 * existing observer/resolution tooling keeps working; NEW poly RPC/subgraph code must
 * live under `lib/poly-indexer/clients/`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Paths under ROOT that may reference blocked URLs with HTTP clients. */
const WHITELIST_PREFIXES = [
  "lib/poly-indexer/clients/polygon-rpc.mjs",
  "lib/poly-indexer/clients/polymarket-subgraph.mjs",
  "lib/resolution/polymarket-outcome.mjs",
  "lib/backfill/polymarket-snapshot-recovery.mjs",
  // Archived arb-pivot A3 export — read-only CSV; see docs/archive/pivot-2026-04/
  "scripts/pivot/a3-resolution-equivalence-export.mjs",
];

const SCAN_ROOTS = ["lib", "src", "scripts"];

const BLOCKED_SNIPPETS = [
  "clob.polymarket.com",
  "polymarket.com/api/trading",
  "polymarket.com/api/orders",
];

/**
 * Rough signal for “this file performs HTTP I/O”.
 * We only flag when BOTH this matches AND a blocked URL appears.
 */
function usesHttpClient(text) {
  return (
    /\bfrom\s+['"]axios['"]/.test(text) ||
    /\brequire\(\s*['"]axios['"]\s*\)/.test(text) ||
    /\bfrom\s+['"]node-fetch['"]/.test(text) ||
    /\bfrom\s+['"]undici['"]/.test(text) ||
    /\bfrom\s+['"]got['"]/.test(text) ||
    /\bgot\s*\(/.test(text) ||
    /from\s+['"]node:http['"]/.test(text) ||
    /from\s+['"]node:https['"]/.test(text) ||
    /\bfetch\s*\(/.test(text) ||
    /\bfetchWithTimeout\s*\(/.test(text)
  );
}

function hasBlockedUrl(text) {
  return BLOCKED_SNIPPETS.some((s) => text.includes(s));
}

function* walkFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      yield* walkFiles(full);
    } else if (/\.(mjs|js|cjs|ts|mts|cts)$/.test(e.name)) {
      yield full;
    }
  }
}

function relPosix(fromRoot) {
  return fromRoot.split(path.sep).join("/");
}

function isWhitelisted(rel) {
  return WHITELIST_PREFIXES.some((w) => rel === w || rel.startsWith(`${w}/`));
}

let violations = 0;
for (const root of SCAN_ROOTS) {
  const absRoot = path.join(ROOT, root);
  if (!fs.existsSync(absRoot)) continue;
  for (const file of walkFiles(absRoot)) {
    const rel = relPosix(path.relative(ROOT, file));
    const text = fs.readFileSync(file, "utf8");
    if (!usesHttpClient(text) || !hasBlockedUrl(text)) continue;
    if (isWhitelisted(rel)) continue;
    console.error(`no-polymarket-write: blocked pattern in ${rel}`);
    violations++;
  }
}

if (violations > 0) {
  console.error(
    `\n${violations} file(s) reference Polymarket trading/CLOB hosts with HTTP without allowlist.\n` +
      "Move read-only Polygon/subgraph code to lib/poly-indexer/clients/ or extend allowlist with owner review.\n",
  );
  process.exit(1);
}
