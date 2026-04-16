Run a **full repo roadmap audit** for prediction-machine: live DB gates, roadmap position, system-state cross-check, and optional Obsidian/Claude wiki vault (`PMCI_WIKI_ROOT`).

**Working directory:** repository root (`prediction-machine`).

## Configuration

- `DATABASE_URL` — required for `verify:schema`, `pmci:smoke`, `pmci:probe` (omit if using docs-only mode).
- `AUDIT_REPO_SKIP_DB=1` — skip DB npm scripts; still reads `docs/roadmap.md`, `docs/system-state.md`, git, and allowlisted wiki files.
- `PMCI_WIKI_ROOT` — optional; default `'/Users/jaylenjohnson/Documents/Claude/Projects/Prediction Machine'`. Only allowlisted wiki files are read (see `scripts/audit/repo-roadmap-audit-lib.mjs`).

## Steps

1. **Parallel evidence (recommended):** split subagents or parallel reads for:
   - `git status -sb`, `git log -5 --oneline`, `git rev-parse HEAD`
   - `docs/roadmap.md` (Current milestone + open phase items), `docs/system-state.md`
   - Wiki: `_home.md`, `80-phases/_index.md` under `PMCI_WIKI_ROOT` if present
2. **Live checks:** `npm run verify:schema`, `npm run pmci:smoke`, `npm run pmci:probe`
3. **Persist (optional):** `npm run audit:repo:daily` → `state/repo-audit/daily/YYYY-MM-DD.json` + delta vs prior day; `npm run audit:repo:weekly` → `state/repo-audit/weekly/YYYY-MM-DD-full-audit.md`
4. **Consolidated report** using the template in `.cursor/skills/repo-roadmap-audit/SKILL.md` — include **Wiki says vs repo says** if any drift.

## Heavier category audit

- `npm run pmci:audit:live` or `npm run audit:repo:full` — same shell script: schema + smoke + local port + sports proposer/audit tails (`scripts/run_pmci_live_audit.sh`). Use when you need sports pipeline evidence, not just roadmap position.

## Rules

- Read-only: do not edit `docs/system-state.md` or wiki files unless the user asks.
- Follow wiki allowlist; do not read paths outside `PMCI_WIKI_ROOT`.
