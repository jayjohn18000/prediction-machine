# repo-roadmap-audit — quick reference

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `PMCI_WIKI_ROOT` | `/Users/jaylenjohnson/Documents/Claude/Projects/Prediction Machine` | Obsidian/Claude wiki vault root (override on other machines). |
| `DATABASE_URL` | _(from `.env`)_ | Required for live `verify:schema`, `pmci:smoke`, `pmci:probe`. |
| `AUDIT_REPO_SKIP_DB` | unset | Set to `1` to skip all DB npm scripts; snapshot includes git + `docs/roadmap.md` + `docs/system-state.md` + allowlisted wiki only (`auditMode: docs_only`). Weekly/daily exit 0. |

## Allowlisted wiki paths (relative to vault root)

- `_home.md`
- `80-phases/_index.md`
- `90-decisions/_index.md`

## NPM commands

| Script | Output |
|--------|--------|
| `npm run audit:repo:daily` | `state/repo-audit/daily/UTC-date.json`, optional `*.delta.md` |
| `npm run audit:repo:weekly` | daily JSON + `state/repo-audit/weekly/UTC-date-full-audit.md` |
| `npm run audit:repo:full` | Same as `pmci:audit:live` → `scripts/run_pmci_live_audit.sh` |

## Key repo files

- `docs/roadmap.md` — milestone line, E2/E3 open `- [ ]` items (parsed under `### E2` / `### E3`).
- `docs/system-state.md` — branch, phase, carry-forward.

## Parallel agent split (optional)

1. Git: `git status -sb`, `git log -5 --oneline`
2. Docs: roadmap + system-state
3. Wiki: allowlisted files only
4. Shell: npm gates (unless `AUDIT_REPO_SKIP_DB=1`)
