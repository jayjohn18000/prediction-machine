/**
 * Shared helpers for repo roadmap audit (daily JSON + weekly markdown).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_WIKI_ROOT =
  '/Users/jaylenjohnson/Documents/Claude/Projects/Prediction Machine';

/** Relative paths under PMCI_WIKI_ROOT that scripts may read (prefix-safe). */
export const WIKI_ALLOWLIST = [
  '_home.md',
  '80-phases/_index.md',
  '90-decisions/_index.md',
];

export function getRepoRoot() {
  return path.resolve(__dirname, '../..');
}

/**
 * Resolve wiki root: env PMCI_WIKI_ROOT or default. Returns null if invalid/not a directory.
 */
export function resolveWikiRoot(explicit) {
  const raw = (explicit || process.env.PMCI_WIKI_ROOT || DEFAULT_WIKI_ROOT).trim();
  if (!raw) return null;
  let abs;
  try {
    abs = fs.realpathSync(raw);
  } catch {
    return null;
  }
  if (!fs.statSync(abs).isDirectory()) return null;
  return abs;
}

/**
 * Ensure candidate file is under root (resolved) — blocks path traversal.
 */
export function isUnderRoot(root, filePath) {
  const resolved = path.resolve(filePath);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return resolved === root || resolved.startsWith(prefix);
}

export function readAllowlistedWikiFiles(wikiRoot) {
  if (!wikiRoot) {
    return { present: false, root: null, files: [] };
  }
  const files = [];
  for (const rel of WIKI_ALLOWLIST) {
    const full = path.join(wikiRoot, rel);
    if (!isUnderRoot(wikiRoot, full)) continue;
    if (!fs.existsSync(full)) {
      files.push({ relative: rel, missing: true });
      continue;
    }
    const text = fs.readFileSync(full, 'utf8');
    const head = text.split('\n').slice(0, 60).join('\n');
    files.push({ relative: rel, missing: false, excerptHead: head, bytes: text.length });
  }
  return { present: true, root: wikiRoot, files };
}

export function getGitInfo(repoRoot) {
  const run = (args) => {
    const r = spawnSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
    });
    return (r.stdout || '').trim();
  };
  let sha = '';
  let branch = '';
  let statusShort = '';
  try {
    sha = run(['rev-parse', 'HEAD']);
    branch = run(['branch', '--show-current']);
    statusShort = run(['status', '-sb']);
  } catch {
    // ignore
  }
  return { sha, branch, statusShort };
}

export function runNpmScript(repoRoot, scriptName) {
  const r = spawnSync('npm', ['run', scriptName], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 12 * 1024 * 1024,
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const combined = stdout + (stderr ? `\n${stderr}` : '');
  return {
    exitCode: r.status ?? 1,
    stdout,
    stderr,
    combined,
  };
}

/**
 * Parse pmci:smoke stdout for numeric counts.
 */
export function parseSmokeCounts(text) {
  const counts = {
    provider_markets: null,
    snapshots: null,
    families: null,
    current_links: null,
  };
  const pm = text.match(/provider_markets:\s*(\d+)/);
  const sn = text.match(/snapshots:\s*(\d+)/);
  const fam = text.match(/families:\s*(\d+)/);
  const cl =
    text.match(/current_links[^:]*:\s*(\d+)/) ||
    text.match(/current_links\s*\(v_market_links_current\):\s*(\d+)/);
  if (pm) counts.provider_markets = Number(pm[1]);
  if (sn) counts.snapshots = Number(sn[1]);
  if (fam) counts.families = Number(fam[1]);
  if (cl) counts.current_links = Number(cl[1]);
  return counts;
}

/**
 * Open `- [ ]` items under `### E2` / `### E3` subsections in docs/roadmap.md.
 */
export function extractOpenChecklistsE2E3(roadmapMd) {
  const e2 = extractOpenItemsUnderSubsection(roadmapMd, /^###\s+E2\b/i);
  const e3 = extractOpenItemsUnderSubsection(roadmapMd, /^###\s+E3\b/i);
  return { e2, e3 };
}

function extractOpenItemsUnderSubsection(md, headingTest) {
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length && !headingTest.test(lines[i].trim())) i++;
  if (i >= lines.length) return [];
  i++;
  const items = [];
  while (i < lines.length) {
    const t = lines[i];
    const trim = t.trim();
    if (/^###\s+/.test(trim) || /^##\s+/.test(trim)) break;
    const m = t.match(/^\s*-\s+\[\s\]\s+(.+)/);
    if (m) items.push(m[1].trim());
    i++;
  }
  return items;
}

export function extractRoadmapMilestone(roadmapMd) {
  const lines = roadmapMd.split('\n');
  let milestone = '';
  for (const line of lines) {
    const t = line.trim();
    if (/^##\s+Current milestone/i.test(t)) {
      milestone = t.replace(/^##\s+/, '').trim();
      break;
    }
  }
  if (!milestone) {
    for (const line of lines) {
      const t = line.trim();
      if (/^\*\*Current milestone:/i.test(t)) {
        milestone = t.replace(/^\*\*|\*\*$/g, '').trim();
        break;
      }
    }
  }
  if (!milestone) {
    const m = roadmapMd.match(/\*\*Current milestone:[^\n]+/i);
    if (m) milestone = m[0].replace(/\*\*/g, '').trim();
  }
  const excerpt = lines.slice(0, 120).join('\n');
  const openChecklists = extractOpenChecklistsE2E3(roadmapMd);
  return {
    milestoneLine: milestone || '(not found — check docs/roadmap.md)',
    excerptHead: excerpt,
    openChecklists,
  };
}

export function extractSystemStateHead(systemMd, maxLines = 80) {
  return systemMd.split('\n').slice(0, maxLines).join('\n');
}

/**
 * Full snapshot for JSON (daily) and weekly markdown.
 */
export function collectAuditSnapshot(repoRoot = getRepoRoot(), wikiRootOpt) {
  const wikiRoot = resolveWikiRoot(wikiRootOpt);
  const git = getGitInfo(repoRoot);
  const skipDb = process.env.AUDIT_REPO_SKIP_DB === '1';

  let roadmap = {
    milestoneLine: '',
    excerptHead: '',
    openChecklists: { e2: [], e3: [] },
  };
  const roadmapPath = path.join(repoRoot, 'docs/roadmap.md');
  if (fs.existsSync(roadmapPath)) {
    const md = fs.readFileSync(roadmapPath, 'utf8');
    roadmap = extractRoadmapMilestone(md);
  }

  let systemState = { excerptHead: '' };
  const sysPath = path.join(repoRoot, 'docs/system-state.md');
  if (fs.existsSync(sysPath)) {
    systemState.excerptHead = extractSystemStateHead(fs.readFileSync(sysPath, 'utf8'));
  }

  const wiki = readAllowlistedWikiFiles(wikiRoot);
  wiki.attemptedPath =
    wikiRootOpt != null && String(wikiRootOpt).trim() !== ''
      ? String(wikiRootOpt).trim()
      : process.env.PMCI_WIKI_ROOT || DEFAULT_WIKI_ROOT;

  if (skipDb) {
    return {
      generatedAt: new Date().toISOString(),
      git,
      auditMode: 'docs_only',
      verifySchema: {
        skipped: true,
        pass: null,
        reason: 'AUDIT_REPO_SKIP_DB=1 (no verify:schema / pmci:smoke / pmci:probe)',
      },
      pmciSmoke: {
        skipped: true,
        pass: null,
        exitCode: null,
        counts: {},
        stdoutExcerpt: '',
      },
      pmciProbe: {
        skipped: true,
        pass: null,
        exitCode: null,
        stdoutExcerpt: '',
      },
      roadmap,
      systemState,
      wiki,
    };
  }

  const verify = runNpmScript(repoRoot, 'verify:schema');
  const smoke = runNpmScript(repoRoot, 'pmci:smoke');
  const probe = runNpmScript(repoRoot, 'pmci:probe');

  const smokeCounts = parseSmokeCounts(smoke.combined);
  const probeExcerpt = (probe.combined || '').slice(0, 12000);

  return {
    generatedAt: new Date().toISOString(),
    auditMode: 'live_db',
    git,
    verifySchema: {
      pass: verify.exitCode === 0,
      exitCode: verify.exitCode,
    },
    pmciSmoke: {
      pass: smoke.exitCode === 0,
      exitCode: smoke.exitCode,
      counts: smokeCounts,
      stdoutExcerpt: (smoke.stdout || '').slice(0, 4000),
    },
    pmciProbe: {
      pass: probe.exitCode === 0,
      exitCode: probe.exitCode,
      stdoutExcerpt: probeExcerpt,
    },
    roadmap,
    systemState,
    wiki,
  };
}

export function utcDateString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function deltaMarkdown(prev, next) {
  const lines = ['# Daily delta', '', `| Field | Previous | Current |`, '|-------|----------|---------|'];
  const keys = [
    ['auditMode', prev?.auditMode, next?.auditMode],
    ['git.sha', prev?.git?.sha, next?.git?.sha],
    ['smoke.provider_markets', prev?.pmciSmoke?.counts?.provider_markets, next?.pmciSmoke?.counts?.provider_markets],
    ['smoke.snapshots', prev?.pmciSmoke?.counts?.snapshots, next?.pmciSmoke?.counts?.snapshots],
    ['smoke.families', prev?.pmciSmoke?.counts?.families, next?.pmciSmoke?.counts?.families],
    ['smoke.current_links', prev?.pmciSmoke?.counts?.current_links, next?.pmciSmoke?.counts?.current_links],
    ['verifySchema.pass', prev?.verifySchema?.pass, next?.verifySchema?.pass],
    ['pmciSmoke.pass', prev?.pmciSmoke?.pass, next?.pmciSmoke?.pass],
    ['pmciProbe.pass', prev?.pmciProbe?.pass, next?.pmciProbe?.pass],
  ];
  for (const [k, a, b] of keys) {
    lines.push(`| ${k} | ${JSON.stringify(a)} | ${JSON.stringify(b)} |`);
  }
  lines.push('');
  return lines.join('\n');
}
