---
name: repo-roadmap-audit
description: >-
  Run a full live repo + roadmap position audit for prediction-machine: merge
  docs/roadmap.md, docs/system-state.md, npm verification, and optional Obsidian/Claude
  wiki folder (PMCI_WIKI_ROOT). Use for “where am I on the roadmap?” status. Prefer
  parallel evidence gathering (git, wiki scan, docs) then consolidate.
---

# Repo roadmap audit (PMCI backend + wiki)

## When to use

- User asks for current roadmap status, phase position, or a “live audit” vs `docs/roadmap.md`.
- After significant merges or before phase gates; weekly review cadence.
- Pair with `npm run audit:repo:daily` / `audit:repo:weekly` for persisted snapshots under `state/repo-audit/`.

## Configuration

| Env | Meaning |
|-----|---------|
| `PMCI_WIKI_ROOT` | Absolute path to the Obsidian/Claude wiki vault (markdown). Default: `/Users/jaylenjohnson/Documents/Claude/Projects/Prediction Machine`. Override on CI or other machines. If missing/unreadable, skip wiki section and say so. |
| `DATABASE_URL` | Required for `verify:schema`, `pmci:smoke`, `pmci:probe` live checks (unless skipping DB). |
| `AUDIT_REPO_SKIP_DB` | Set to `1` to run **docs/wiki/git only** — no npm DB scripts; use for markdown-only weekly generation or CI without secrets. See `reference.md`. |

See **`reference.md`** in this skill folder for allowlisted paths and command matrix.

**Wiki safety:** Only read files **under** `PMCI_WIKI_ROOT` using the allowlist in `scripts/audit/repo-roadmap-audit-lib.mjs` (or the same logic). Do not walk arbitrary paths.

## Parallel evidence gathering (recommended)

Split work across subagents or parallel tool calls:

1. **Git / tree:** `git status -sb`, `git log -5 --oneline`, `git rev-parse HEAD`.
2. **Repo docs:** Read `docs/roadmap.md` (focus “Current milestone” and active phase checklists), `docs/system-state.md` (branch, phase, carry-forward).
3. **Wiki (if `PMCI_WIKI_ROOT` exists):** Read `_home.md`, `80-phases/_index.md`, optionally `90-decisions/_index.md` — note active phase lines and `last-verified` dates.
4. **Live backend:** Run `npm run verify:schema`, `npm run pmci:smoke`, `npm run pmci:probe` from repo root (needs `DATABASE_URL`).

Then **merge** into one report.

## Live checks (canonical commands)

From repository root:

```bash
npm run verify:schema
npm run pmci:smoke
npm run pmci:probe
```

Record pass/fail and numeric baselines from smoke (`provider_markets`, `snapshots`, `families`, `current_links`).

Optional: `curl -sS --max-time 5 https://pmci-api.fly.dev/v1/health/freshness` for production pulse (read-only).

**Relation to other audits**

- `npm run pmci:audit:live` — `scripts/run_pmci_live_audit.sh`: schema + smoke + local port probe + **sports** proposer/audit packet tails; heavier and category-specific.
- `npm run audit:repo:daily` — persisted JSON + delta under `state/repo-audit/daily/` (roadmap-oriented).
- See `.claude/commands/pmci-status.md` for a shorter DB/API diagnostic template.

## Roadmap position (repo source of truth)

1. Parse **`docs/roadmap.md`**: identify the **Current milestone** line and open `[ ]` items under active phases (e.g. E2/E3).
2. Cross-check **`docs/system-state.md`**: branch, declared phase, carry-forward bullets — flag contradictions with roadmap or wiki.

## Wiki alignment (“Wiki says vs repo says”)

Compare:

- Wiki dashboard (`_home.md`): active phase, Fly URLs, carry-forward bullets.
- `80-phases/_index.md`: phase table vs repo roadmap milestone.

If `last-verified` in wiki is stale vs today’s evidence, note it. If phase labels disagree, list both and recommend updating the stale doc.

## Output format

Produce a structured report:

```text
PMCI Repo Roadmap Audit — <ISO timestamp>
Git: <branch> @ <short sha>
Gates: verify:schema <pass|fail>, pmci:smoke <pass|fail>, pmci:probe <pass|fail>
Smoke counts: markets=… snapshots=… families=… current_links=…
Roadmap milestone (repo): <one-line summary>
System-state summary: <one-line>
Wiki (<path or skipped>): <one-line summary>
Drift / contradictions: <bullets or "none">
Next actions: <bullets>
```

Do not modify `docs/system-state.md` or wiki files unless the user explicitly asks.

## Persistence

After a manual audit, operators can run `npm run audit:repo:daily` to write JSON (and delta vs prior day) under `state/repo-audit/`. See `state/repo-audit/README.md`.
