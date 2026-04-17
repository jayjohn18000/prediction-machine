# Repo audit state (prediction-machine)

Machine- and human-readable artifacts from `npm run audit:repo:daily` and `audit:repo:weekly`.

## Layout

| Path | Purpose |
|------|---------|
| `daily/YYYY-MM-DD.json` | Full snapshot: git, `verify:schema`, `pmci:smoke` counts, `pmci:probe` excerpt, roadmap/system-state heads, allowlisted wiki excerpts. |
| `daily/YYYY-MM-DD.delta.md` | Written when **yesterday’s** JSON exists; field-level diff vs prior UTC calendar day. |
| `weekly/YYYY-MM-DD-full-audit.md` | Narrative weekly report (roadmap excerpt, system-state excerpt, wiki heads, probe tail). |

Dates use **UTC** (`toISOString().slice(0, 10)`).

## Wiki path (`PMCI_WIKI_ROOT`)

Scripts only read an **allowlisted** set of markdown files under the vault root (see `scripts/audit/repo-roadmap-audit-lib.mjs`). Default path matches the Claude Projects vault:

`/Users/jaylenjohnson/Documents/Claude/Projects/Prediction Machine`

Obsidian may also mirror under `~/Obsidian/Prediction Machine/` — set `PMCI_WIKI_ROOT` to whichever checkout you want audited.

## Git retention

By default, **`daily/*.json` is gitignored** to avoid noisy commits; **`weekly/*.md` is tracked** if you want history in-repo. Adjust `.gitignore` if your team prefers committing daily JSON or ignoring all of `state/`.

## Scheduling (local)

### Daily cron (every day)

1. Put `DATABASE_URL` (and optional `PMCI_WIKI_ROOT`) in **`~/.config/prediction-machine/audit.env`** or **`prediction-machine/.env.cron.local`** (both gitignored for the latter pattern via `.env.cron.local`).
2. From the repo root, install the user crontab entry (default **06:30** in the **server’s local timezone**; override with `MINUTE` / `HOUR`):

```bash
./scripts/cron/install-daily-cron.sh
# Example: run at 07:45 local time daily
# MINUTE=45 HOUR=7 ./scripts/cron/install-daily-cron.sh
```

This runs `scripts/cron/run-repo-roadmap-audit-daily.sh`, which sets a sane `PATH`, sources the env files, then `npm run audit:repo:daily`. Logs append to `state/repo-audit/cron.log` (ignored via `*.log`).

To remove the job later: `crontab -e` and delete the two lines marked `prediction-machine: audit:repo:daily`, or run `crontab -l | grep -v 'run-repo-roadmap-audit-daily.sh' | grep -v '# prediction-machine: audit:repo:daily' | crontab -`.

**Manual one-off** (same as cron):

```bash
./scripts/cron/run-repo-roadmap-audit-daily.sh
```

**Weekly** (e.g. Sunday):

```bash
cd /path/to/prediction-machine && DATABASE_URL=... npm run audit:repo:weekly
```

Requires `DATABASE_URL` for live DB checks (unless you set **`AUDIT_REPO_SKIP_DB=1`**, which skips `verify:schema` / `pmci:smoke` / `pmci:probe` and writes `auditMode: docs_only` — exit code 0; use for weekly markdown without database access).

**Examples**

```bash
# Full live audit (needs .env / DATABASE_URL)
cd /path/to/prediction-machine && npm run audit:repo:daily

# Docs + wiki + git only (no DATABASE_URL)
cd /path/to/prediction-machine && AUDIT_REPO_SKIP_DB=1 npm run audit:repo:weekly
```

## Related commands

| Command | Role |
|---------|------|
| `npm run audit:repo:daily` | JSON + delta |
| `npm run audit:repo:weekly` | Daily JSON refresh + weekly markdown |
| `npm run pmci:audit:live` | Sports-heavy live shell audit (`scripts/run_pmci_live_audit.sh`) |
| `npm run audit:repo:full` | Alias of `pmci:audit:live` (same script) |

Agent-facing workflow: `.cursor/skills/repo-roadmap-audit/SKILL.md`.
