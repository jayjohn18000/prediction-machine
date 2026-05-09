# Phase 0 Stream F — scanner output (final handoff)

## Branch and scope

- **Current git branch (this workspace):** `phase-0/stream-d-mm-v1-patch` (not renamed to `phase-0/stream-f-scanner-output`). Re-check out or cherry-pick Stream F commits if you want a dedicated Stream F branch only.
- **Stream A:** Reported **READY** per task packet; this implementation **assumes** `pmci.hypotheses`, `pmci.alerts`, `pmci.scanner_signals_unified`, `pmci.hypothesis_decay_state`, etc. exist remotely. There is **no** Stream A DDL in this repo snapshot’s migrations—operators must apply Stream A before `20260509184500_pmci_stream_f_audit_log_and_scanner_crons.sql`, or crons will POST to the API while DB queries fail or no-op.

## What shipped (code)

| Area | Path / note |
|------|-------------|
| Report paths + filenames | `lib/scanner/report-paths.mjs` |
| Wilson CI + ambiguity star | `lib/scanner/stats-ci.mjs` |
| Defensive SQL loaders | `lib/scanner/scanner-queries.mjs` (empty/failed queries → empty sections) |
| Daily / weekly render + auto-retire | `lib/scanner/daily-report-render.mjs`, `lib/scanner/weekly-digest-render.mjs` (`runAutoRetire` before weekly write) |
| S3 optional upload | `lib/scanner/s3-upload-report.mjs` (needs `AWS_*` + region + `PMCI_REPORTS_S3_BUCKET`) |
| Pager delivery | `lib/scanner/alert-delivery.mjs`, SMTP `lib/scanner/smtp-send.mjs` |
| Templates | `templates/daily-report.html.hbs`, `templates/weekly-digest.html.hbs` |
| CLI | `scripts/cli/pmci-hypothesis.mjs`, `scripts/cli/pmci-report.mjs` |
| Worker + render CLIs | `scripts/scanner/*.mjs`, `scripts/scanner/run-backtest-nightly.mjs` (stub) |
| Static HTML routes (no API key) | `src/routes/reports-static.mjs` — `GET /reports/daily/:file`, `GET /reports/weekly/:file` |
| API hook | `src/server.mjs` — bypass auth for `/reports/*` |
| Admin jobs (in-process Pattern 4 friendly) | `src/routes/admin-jobs.mjs` — `scanner-daily-report`, `scanner-alert-delivery`, `scanner-weekly-digest`, spawn `scanner-backtest-nightly` |
| Edge JOB_MAP | `supabase/functions/pmci-job-runner/index.ts` — `scanner:*` + `scanner-backtest-nightly` |
| Migration | `supabase/migrations/20260509184500_pmci_stream_f_audit_log_and_scanner_crons.sql` |
| Schema verify | `scripts/validation/verify-pmci-schema.mjs` includes `hypothesis_state_log` |
| Fly image | `Dockerfile` creates `reports/daily`, `reports/weekly` |
| npm scripts | `pmci:hypothesis`, `pmci:report`, `scanner:*` in `package.json` |

## Migration contents (summary)

1. `CREATE OR REPLACE FUNCTION pmci.trigger_job_runner(text)` — forwards `{"job": …}` to Vault-configured job-runner URL (same pattern as `mm-ingest-outcomes` cron).
2. `pmci.hypothesis_state_log` — **`hypothesis_id` is `TEXT` without a FK** to avoid uuid/text drift between Stream A drafts; operators should treat it as the logical join key to `pmci.hypotheses.id`.
3. `ALTER` on `pmci.hypotheses` / `pmci.alerts` when those tables exist (`retired_*`, `delivery_attempts`, `last_attempt_at`, `tradable`, `body`, `subject`).
4. pg_cron: `pmci-scanner-daily-report` (00:30 UTC), `pmci-scanner-alert-delivery` (every minute), `pmci-scanner-weekly-digest` (Sun 06:00 UTC).

### Pattern 4 (per migration comments)

- **Daily digest HTML:** cron run rows in `cron.job_run_details`; artefact exists at `{PMCI_REPORTS_LOCAL_DIR|`reports`}/daily/daily-report-YYYY-MM-DD.html` or S3 mirror.
- **Alert delivery:** `pmci.alerts` rows gain `delivered_at` / `delivery_status` updates.
- **Weekly:** `weekly-digest-*.html` plus `hypothesis_state_log` + retired hypotheses when auto-retire runs.

## Operational URLs

- **Reports on API host:** `https://<pmci-api-host>/reports/daily/<file>.html` (and `/reports/weekly/…`).
- **S3 (optional):** `s3://pmci-reports/daily/<YYYY-MM-DD>.html` pattern when credentials + bucket configured.

## Verification performed locally

| Check | Result |
|-------|--------|
| `node --check` on new modules | Passed |
| `npm test` | **Failed** — existing `test/routes/signals.test.mjs` expectations (500 vs 200 on top-divergences); **not attributed to Stream F** in this session. |
| DB migration apply / live cron fire | **Not run** here (no `DATABASE_URL` + Stream A schema in this environment). |

## Task packet checklist (honest)

| Item | Status |
|------|--------|
| Daily report end-to-end on synthetic data | **Partial** — renderer runs; full proof needs Stream A views + optional seed rows on a real DB. |
| Pager FK trigger blocks non-live insert | **Not captured** — requires live DB with Stream A trigger; paste error text when run. |
| CLI `promote` writes audit log | **Code present**; verify against DB. |
| Auto-retire on `triggers_retire` | **Code present** in `runAutoRetire`; verify with synthetic decay row. |
| Pattern 4 notes | **In migration comments** + this file. |
| No `--mode=demo` in Stream F diff | **Satisfied** (MM rotator spawn still supports demo only when explicitly requested — unchanged contract). |

## Overall verdict

**READY (code merged in working tree)** for operator review and DB-backed validation, with **BLOCKED ON: remote Stream A schema + `supabase db push` + first manual admin job smoke** before calling production cron paths done.

## Suggested next commands (operator)

```bash
# After Stream A is on the database:
npx supabase db push   # or your approved migration path
npm run verify:schema

# Smoke (with PMCI_ADMIN_KEY + API):
curl -sS -X POST -H "Content-Type: application/json" -H "X-PMCI-API-KEY: $PMCI_API_KEY" \
  -H "X-PMCI-ADMIN-KEY: $PMCI_ADMIN_KEY" \
  "$PMCI_SERVER_URL/v1/admin/jobs/scanner-daily-report" -d '{}'

npm run scanner:alert-delivery
npm run pmci:report dashboard --port 8080
```

---

*Generated 2026-05-09 as part of Stream F implementation handoff.*
