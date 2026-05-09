# Phase 0 Stream B — final report

## Gate: Stream A

- **Schema / ledger:** **READY** — migrations `20260509120000`–`20260509120200` applied per `phase-0-stream-a-final-report.md`; `mm_fills` extensions (`entry_price`, `was_maker`, `settlement_outcome`, `settled_value`) available.
- **AWS Ohio normalizer:** **BLOCKED on operator** — Terraform + `aws`/`session-manager` not run in Stream A workspace; EC2 systemd not verified. NBA lag + microstructure detectors are **implemented in repo** but **not deployed** until the normalizer runs on the provisioned host.

## Branch

- **`phase-0/stream-b-detectors`** (based off `phase-0/stream-a-schema-normalizer` / Stream A schema tip).

## Commits

```
db9c333 docs(phase-0): list both Stream B commits in final report
6b7a69a docs(phase-0): fix Stream B report HEAD SHA
2ff9715 feat(scanner): Stream B Whelan daily cron, NBA lag + microstructure detectors
```

Pushed: **`origin/phase-0/stream-b-detectors`**

## Deliverables

| Deliverable | Status |
|-------------|--------|
| **Track A — Whelan daily SQL + pg_cron (`pmci-scanner-whelan-aggregate`)** | **Deployed and verified** — migration `supabase/migrations/20260509123000_pmci_scanner_whelan_cron.sql` applied via `psql`; `cron.schedule` job id **67**; `schema_migrations` row `20260509123000` inserted; one-shot `runWhelanStructuralAggregate` executed (`inserted: 0` — no qualifying `mm_fills` in **previous UTC calendar day** window). |
| **Track A — Edge + API wiring** | **Code merged on branch; deploy/verify by operator** — `JOB_MAP` entry in `supabase/functions/pmci-job-runner/index.ts`; admin handler in `src/routes/admin-jobs.mjs`. **Supabase:** redeploy `pmci-job-runner` so JSON body job name reaches Fly. **Fly `pmci-api`:** deploy so `POST /v1/admin/jobs/pmci-scanner-whelan-aggregate` exists. Cron HTTP chain is **not** re-validated end-to-end from this workspace after Edge deploy. |
| **Track B — Microstructure (`detector_track=`)** | **Code-only, awaiting AWS** — `pmci-normalizer/src/detectors/microstructure-scoring.mjs` + `lib/scanner/microstructure-weights.json`; wired in `pmci-normalizer/src/index.mjs` (1 Hz throttle per ticker, Kalshi L2 via `lib/ingestion/depth.mjs`). |
| **NBA informational lag + resolution loop** | **Code-only, awaiting AWS** — `pmci-normalizer/src/detectors/nba-informational-lag.mjs`, `lib/scanner/hoopR-lite.mjs`; NBA CDN path uses **S3 raw upload only** (no strength-0 scanner row); gated inserts into `pmci.scanner_informational_lag_signals`; `setInterval(60s)` calls `resolveAgedInformationalLagSignals`. |
| **Shared helpers** | `lib/scanner/whelan-aggregate.mjs` (Track A job SQL), `scripts/validation/pmci-scanner-whelan-validation.sql` (Pattern 4 GROUP BY query). |

## Pattern 4 — Whelan validation SQL (captured after migration + manual aggregate)

```text
 n | detector_track | price_band | side 
---+----------------+------------+------
(0 rows)
```

*(Zero rows in 24h are expected until either settled-band fills exist in the UTC-day window or microstructure/NBA writers produce `scanner_structural_signals` / informational-lag rows.)*

**Manual aggregate run:**

```text
{"inserted":0}
```

## Verification checklist (prompt §VERIFICATION)

| Check | Result |
|-------|--------|
| `scanner_informational_lag_signals` last 4h | **Not verified** — normalizer not on AWS; expect 0 until deploy + live NBA + mapped Kalshi market + snapshots. |
| `scanner_structural_signals` 24h both tracks | **Partial** — SQL validated empty; `whelan_band` fires daily; `microstructure` needs AWS normalizer. |
| Resolution worker | **Code** lands in normalizer; **not** runtime-verified here. |
| Whelan Pattern 4 | **Query committed** + output above captured. |
| No new `--mode=demo` in Stream B files | **Pass** for added/changed scanner paths (`grep` on Stream B paths clean for `mode=demo`). |

## READY / BLOCKED

- **READY:** Track A database cron + server-side aggregate function wired on branch; local DB migration apply + manual SQL smoke completed.
- **BLOCKED ON:** **AWS Ohio normalizer host** (provision, deploy `pmci-normalizer`, secrets); **Supabase Edge deploy** for `pmci-job-runner`; **Fly `pmci-api` deploy** for new admin job route; end-to-end **HTTP cron → Fly → INSERT** not re-run after prod Edge/API ship.

## Operator next steps

1. Push `phase-0/stream-b-detectors` (already checked out locally for review).
2. Deploy `pmci-api` + redeploy `pmci-job-runner`; confirm `POST` job returns 200 and, when fills exist in-window, `inserted > 0`.
3. Apply Terraform Ohio + SSM/start `pmci-normalizer.service`; confirm `scanner_structural_signals.microstructure` and gated `scanner_informational_lag_signals` rows over a game window.
4. **Do not open a PR** per Stream B instructions (branch review only).
