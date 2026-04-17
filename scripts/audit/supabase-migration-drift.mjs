#!/usr/bin/env node
/**
 * Local migration inventory + optional compare to a remote list (e.g. from MCP list_migrations).
 * Does not call Supabase APIs — safe for CI without OAuth.
 *
 * Usage:
 *   node scripts/audit/supabase-migration-drift.mjs
 *   node scripts/audit/supabase-migration-drift.mjs --remote-json ./remote.json
 *
 * Remote JSON shapes accepted:
 *   { "migrations": ["20260225000001_name.sql", ...] }
 *   { "remote": [ "...sql" ] }
 *   [ "20260225000001_name.sql", ... ]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getRepoRoot() {
  return path.resolve(__dirname, '../..');
}

function parseArgs(argv) {
  const args = { remoteJson: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--remote-json') args.remoteJson = argv[++i] || null;
  }
  return args;
}

function usage() {
  console.log(`supabase-migration-drift — local migrations vs optional remote list

Usage:
  node scripts/audit/supabase-migration-drift.mjs [--remote-json <file>]

Options:
  --remote-json <path>   JSON file from MCP list_migrations (or array of names)
  -h, --help             Show this help

Examples:
  npm run audit:supabase:migration-drift
  npm run audit:supabase:migration-drift -- --remote-json ./remote-migrations.json
`);
}

function listLocalMigrations(repoRoot) {
  const dir = path.join(repoRoot, 'supabase', 'migrations');
  if (!fs.existsSync(dir)) {
    throw new Error(`Missing migrations directory: ${dir}`);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files;
}

function normalizeName(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.endsWith('.sql') ? t : `${t}.sql`;
}

function extractRemoteList(raw) {
  if (Array.isArray(raw)) {
    return raw.map(normalizeName).filter(Boolean);
  }
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.migrations)) {
      return raw.migrations.map(normalizeName).filter(Boolean);
    }
    if (Array.isArray(raw.remote)) {
      return raw.remote.map(normalizeName).filter(Boolean);
    }
    if (Array.isArray(raw.names)) {
      return raw.names.map(normalizeName).filter(Boolean);
    }
  }
  return null;
}

function diffLists(local, remote) {
  const localSet = new Set(local);
  const remoteSet = new Set(remote);
  const onlyLocal = local.filter((x) => !remoteSet.has(x));
  const onlyRemote = remote.filter((x) => !localSet.has(x));
  let orderedMatch = local.length === remote.length;
  if (orderedMatch) {
    for (let i = 0; i < local.length; i++) {
      if (local[i] !== remote[i]) {
        orderedMatch = false;
        break;
      }
    }
  }
  return { onlyLocal, onlyRemote, orderedMatch };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  const repoRoot = getRepoRoot();
  const local = listLocalMigrations(repoRoot);

  let remote = [];
  if (args.remoteJson) {
    const abs = path.resolve(process.cwd(), args.remoteJson);
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const extracted = extractRemoteList(raw);
    if (!extracted) {
      console.error(
        'Remote JSON must be an array or an object with migrations[] / remote[] / names[]',
      );
      process.exit(1);
    }
    remote = extracted;
  }

  const hasRemote = Boolean(args.remoteJson);
  const drift = hasRemote
    ? diffLists(local, remote)
    : { onlyLocal: [], onlyRemote: [], orderedMatch: null };

  const out = {
    generatedAt: new Date().toISOString(),
    repoRoot,
    local,
    remote: hasRemote ? remote : null,
    onlyLocal: drift.onlyLocal,
    onlyRemote: drift.onlyRemote,
    orderedMatch: hasRemote ? drift.orderedMatch : null,
    hint: hasRemote
      ? null
      : 'No --remote-json: compare local list to MCP list_migrations and re-run with --remote-json',
  };

  console.log(JSON.stringify(out, null, 2));

  if (hasRemote && (drift.onlyLocal.length > 0 || drift.onlyRemote.length > 0)) {
    process.exit(2);
  }
  process.exit(0);
}

main();
