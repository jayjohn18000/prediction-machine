#!/usr/bin/env node
/**
 * Weekly full audit markdown: runs daily capture, then writes narrative report under
 * state/repo-audit/weekly/YYYY-MM-DD-full-audit.md
 * Template aligned with docs/reports/live-roadmap-audit-*.md (Summary, Evidence-first, Drift, Next moves).
 *
 * Env: DATABASE_URL (unless AUDIT_REPO_SKIP_DB=1), PMCI_WIKI_ROOT (optional).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  collectAuditSnapshot,
  getRepoRoot,
  utcDateString,
} from './repo-roadmap-audit-lib.mjs';

function main() {
  const repoRoot = getRepoRoot();
  const day = utcDateString();
  const weeklyDir = path.join(repoRoot, 'state/repo-audit/weekly');
  fs.mkdirSync(weeklyDir, { recursive: true });

  const snapshot = collectAuditSnapshot(repoRoot);

  const dailyDir = path.join(repoRoot, 'state/repo-audit/daily');
  fs.mkdirSync(dailyDir, { recursive: true });
  const dailyPath = path.join(dailyDir, `${day}.json`);
  fs.writeFileSync(dailyPath, JSON.stringify(snapshot, null, 2), 'utf8');

  const wikiRoot =
    snapshot.wiki?.root ||
    snapshot.wiki?.attemptedPath ||
    process.env.PMCI_WIKI_ROOT ||
    '(see PMCI_WIKI_ROOT / DEFAULT in repo-roadmap-audit-lib.mjs)';
  const wikiFiles = (snapshot.wiki?.files || [])
    .filter((f) => !f.missing)
    .map((f) => f.relative)
    .join(', ');

  const oc = snapshot.roadmap?.openChecklists || { e2: [], e3: [] };
  const openE2 = (oc.e2 || []).map((t) => `  - [ ] ${t}`);
  const openE3 = (oc.e3 || []).map((t) => `  - [ ] ${t}`);

  const evidence = [];
  if (snapshot.auditMode === 'docs_only') {
    evidence.push(
      '- **DB gates:** SKIPPED — set `AUDIT_REPO_SKIP_DB=1`; no `verify:schema` / `pmci:smoke` / `pmci:probe` run.',
    );
  } else {
    const c = snapshot.pmciSmoke.counts;
    evidence.push(`- \`npm run verify:schema\`: ${snapshot.verifySchema.pass ? 'PASS' : 'FAIL'}.`);
    evidence.push(
      `- \`npm run pmci:smoke\`: ${snapshot.pmciSmoke.pass ? 'PASS' : 'FAIL'} — provider_markets=${c.provider_markets ?? 'n/a'}, snapshots=${c.snapshots ?? 'n/a'}, families=${c.families ?? 'n/a'}, current_links=${c.current_links ?? 'n/a'}.`,
    );
    evidence.push(`- \`npm run pmci:probe\`: ${snapshot.pmciProbe.pass ? 'PASS' : 'FAIL'}.`);
  }
  evidence.push(`- \`git status -sb\` (first line): \`${(snapshot.git.statusShort || '').split('\n')[0] || 'n/a'}\``);
  evidence.push(`- **PMCI_WIKI_ROOT:** \`${wikiRoot}\` — files: ${wikiFiles || '(none)'}`);

  const lines = [
    `# PMCI Live Roadmap Audit — ${day}`,
    '',
    `_Generated: ${snapshot.generatedAt} (UTC)_`,
    '',
    `- **auditMode:** \`${snapshot.auditMode || 'live_db'}\` (${snapshot.auditMode === 'docs_only' ? 'AUDIT_REPO_SKIP_DB=1' : 'live DB checks'})`,
    '',
    '## Summary',
    '',
    `- **Git:** \`${snapshot.git.branch || '?'}\` @ \`${(snapshot.git.sha || '').slice(0, 12)}\``,
    `- **Roadmap milestone (repo):** ${snapshot.roadmap.milestoneLine || '_(see docs/roadmap.md)_'}`,
    `- **Open E2 checklist items:** ${oc.e2?.length ?? 0} | **Open E3 checklist items:** ${oc.e3?.length ?? 0}`,
    `- **Wiki:** ${snapshot.wiki?.present ? `read allowlisted files (${wikiFiles || 'n/a'})` : 'vault not read (missing path or unreadable)'}`,
    '',
    '## Evidence-first findings',
    '',
    ...evidence,
    '',
    '## Drift notes',
    '',
    '- Compare wiki `last-verified` / active-phase lines with `docs/roadmap.md` **Current milestone** and `docs/system-state.md` carry-forward.',
    '- If this run used `AUDIT_REPO_SKIP_DB=1`, re-run weekly without it for live DB evidence.',
    '',
    '## Open checklist (E2 / E3) from docs/roadmap.md',
    '',
    '### E2',
    ...(openE2.length ? openE2 : ['  - _(none parsed under ### E2)_']),
    '',
    '### E3',
    ...(openE3.length ? openE3 : ['  - _(none parsed under ### E3)_']),
    '',
    '## Roadmap excerpt (repo, truncated)',
    '',
    '```',
    snapshot.roadmap.excerptHead.slice(0, 3500),
    snapshot.roadmap.excerptHead.length > 3500 ? '\n… (truncated)' : '',
    '```',
    '',
    '## System state (repo, excerpt)',
    '',
    '```',
    snapshot.systemState.excerptHead.slice(0, 2500),
    snapshot.systemState.excerptHead.length > 2500 ? '\n… (truncated)' : '',
    '```',
    '',
    '## Wiki excerpts (allowlisted heads)',
    '',
  ];

  for (const f of snapshot.wiki?.files || []) {
    lines.push(`### ${f.relative}`, '');
    if (f.missing) {
      lines.push('_(file missing)_', '');
      continue;
    }
    lines.push('```', (f.excerptHead || '').slice(0, 2000), '```', '');
  }

  lines.push(
    '## Probe output (truncated)',
    '',
    '```',
    snapshot.auditMode === 'docs_only'
      ? '(skipped — docs-only mode)'
      : (snapshot.pmciProbe?.stdoutExcerpt || '').slice(0, 6000),
    '```',
    '',
    '## Next moves',
    '',
    '1. Reconcile wiki vs `docs/roadmap.md` / `docs/system-state.md` when labels diverge.',
    '2. Clear failing gates (`verify:schema`, `pmci:smoke`, `pmci:probe`) before phase work.',
    '3. Burn down open E2/E3 checklist items; update wiki `last-verified` after doc changes.',
    '',
  );

  const outPath = path.join(weeklyDir, `${day}-full-audit.md`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`audit:repo:weekly wrote ${path.relative(repoRoot, outPath)}`);

  const docsOnly = snapshot.auditMode === 'docs_only';
  const anyFail =
    !docsOnly &&
    (!snapshot.verifySchema.pass || !snapshot.pmciSmoke.pass || !snapshot.pmciProbe.pass);
  process.exit(anyFail ? 1 : 0);
}

main();
