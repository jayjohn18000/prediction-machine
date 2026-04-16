#!/usr/bin/env node
/**
 * Daily repo audit snapshot: verify:schema, pmci:smoke, pmci:probe + git + wiki allowlist.
 * Writes state/repo-audit/daily/YYYY-MM-DD.json and optional delta vs prior calendar day.
 *
 * Env: DATABASE_URL (for checks), PMCI_WIKI_ROOT (optional), AUDIT_REPO_SKIP_DB=1 (skip DB npm scripts).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  collectAuditSnapshot,
  deltaMarkdown,
  getRepoRoot,
  utcDateString,
} from './repo-roadmap-audit-lib.mjs';

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function yesterdayUtcDate() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return utcDateString(d);
}

function main() {
  const repoRoot = getRepoRoot();
  const outDir = path.join(repoRoot, 'state/repo-audit/daily');
  fs.mkdirSync(outDir, { recursive: true });

  const day = utcDateString();
  const snapshot = collectAuditSnapshot(repoRoot);

  const jsonPath = path.join(outDir, `${day}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`audit:repo:daily wrote ${path.relative(repoRoot, jsonPath)}`);

  const prevDay = yesterdayUtcDate();
  const prevPath = path.join(outDir, `${prevDay}.json`);
  const prev = readJsonSafe(prevPath);
  if (prev) {
    const deltaPath = path.join(outDir, `${day}.delta.md`);
    fs.writeFileSync(deltaPath, deltaMarkdown(prev, snapshot), 'utf8');
    console.log(`audit:repo:daily wrote ${path.relative(repoRoot, deltaPath)}`);
  } else {
    console.log(`audit:repo:daily: no prior snapshot at ${prevPath} (delta skipped)`);
  }

  const docsOnly = snapshot.auditMode === 'docs_only';
  const anyFail =
    !docsOnly &&
    (!snapshot.verifySchema.pass || !snapshot.pmciSmoke.pass || !snapshot.pmciProbe.pass);
  process.exit(anyFail ? 1 : 0);
}

main();
