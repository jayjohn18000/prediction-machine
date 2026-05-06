# Prediction Machine — Claude Context

> **CURRENT PHASE (2026-05-05): PROD MM live capital, day 3 of 7 (ADR-012 clock). 🚨 QUOTING PAUSED ~11h — see anomaly below.**
>
> Status is tracked across three independent axes. Conflating them produces "we shipped" claims that survive only until the next status check.
>
> **(a) Code merged** (binary, verify from git):
> - MM Pre-W2 + W2–W6 merged 2026-04-28 (W6 closed feature-complete).
> - MM triage A (PnL+positions), B (depth feed), C (order reconciler) merged 2026-04-29.
> - Daily ticker rotator + 24h heartbeat verifier merged 2026-04-30.
> - Tracks B/C/D/E (arb sunset cleanup, v2 prep docs, open decisions, triage memo) merged 2026-05-01.
> - Tracks F (F.1–F.5 MM runtime fixes), H (reconcile-timeout hotfix), I (Kalshi DEMO WS spaced subscribes), J (WS heartbeat + per-ticker staleness watchdog) all merged 2026-05-01 → 2026-05-02.
> - **2026-05-02 same-day cutover patch sweep + ADR-011 + ADR-012:** `/admin/restart` fail-closed, `/health/mm` 503-on-crit, `MM_RUN_MODE=prod` env switch (`lib/mm/kalshi-env.mjs`), `DEFAULT_MM_PARAMS_PROD` ($5/day, $30 notional via `deriveHardPositionLimit`), outcome-ingest cron, `mm_fills.kalshi_*_fee_cents` columns, RLS+revoke on poly partition children, intra-tick `kill_switch_active` re-read, idle-state liveness heartbeat, withdrawal runbook. Commits `f80c05b`, `66c1444`, `ff207c6`, `f6907ba`, `d62bff2`, `3302f5c`, `073528b`.
> - **2026-05-04 Track M merged:** `fe38286` — fee capture from Kalshi fills (`mm_fills.kalshi_*_fee_cents` writer), `quote_age_ms_at_fill` column + writer, worst-trade alarm. Migration `20260504120000_pmci_mm_fills_quote_age_ms.sql` was already on live DB at 2026-05-04 sync; code now matches.
> - **2026-05-04 Rotator quality merged:** `de5fbc3` — score rewrite (vol×category×urgency×spread), `pmci.mm_ticker_blocklist` table + `mm-rotator-disable-watcher` cron (5min), reject-rate auto-blocklist (1h/24h windows), diversification caps (3/event, 5/sport), Kalshi /markets cursor pagination, PROD target=10 / min_close=4h, multi-cron MLB/NBA UTC anchors. Authored as "ADR-013 selection-only; no quoting changes" — note that ADR-013 is reserved for the hour-168 verdict and decision-log has not been touched. **HEAD at start of 2026-05-05 update = `de5fbc3`**.
> - Polymarket indexer Pre-W1 + W1 merged 2026-04-28 (ADR-009).
> - Polymarket indexer W2 (live Polygon ingestion via `pmci-poly-indexer` Fly app) NOT started.
>
> **(b) Writers verified persisting** (DB rows in expected intervals — Pattern 4 of the audit):
> - `pmci-mm-runtime` health endpoint: ⚠️ `ok=true ready=false severity=warn loopTick=7713 depth 1/1 connected runMode=prod` (2026-05-05 13:31Z). The `1/1 depth` figure is **stale config**: only `KXMLBSPREAD-26MAY042138CWSLAA-CWS7` is subscribed, and that ticker was auto-blocklisted at 02:50Z (`high_reject_rate`, 314/404 rejects = 77.7%). The 8 currently-enabled rotator-seeded markets have **no depth subscription** — orchestrator process is alive (idleHeartbeatAt ticking) but functionally paused.
> - Orders / fills writers: ✅ writes persisting *when issued* — lifetime `mm_orders=61,556` (+1,143 vs 2026-05-04 sync); lifetime `mm_fills=425` (+102); `mm_orders_24h=1,140` (552 open / 469 rejected / 94 filled / 25 cancelled). **24h fill ratio = 8.7%** (above the 0.1% floor; healthy band). 🚨 **`mm_orders_6h=0`, `mm_orders_1h=0` — last order at 2026-05-05T03:15:17Z, last fill at 03:15:14Z. ~11h of zero quoting, all on yesterday's universe (NBA totals + MLB spread).**
> - `kill_switch_events`: ✅ 24h delta = **5** (3× `reject_storm`, 1× `consecutive_adverse_fills`, 1× `fill_rate_floor` — all firing on the now-blocklisted KXMLBSPREAD before its disable; cumulative 44,427 = unchanged 44,377 DEMO-storm baseline + 50 since T0).
> - PnL writer: ✅ persisting — `mm_pnl_snapshots_24h=2,288`, latest snapshot `2026-05-05T14:45:00Z`. Net PnL since ADR-012 T0 = **−77.8c** (spread_capture +311.5, adverse −159.2, inv_drift −7.0, fees −223). Within $5/day cap cumulatively over ~2.7 days.
> - `mm_orders.status` propagation: ✅ working (552 open / 469 rejected / 94 filled / 25 cancelled in 24h).
> - `mm-ingest-outcomes` cron: ✅ writes confirmed — `market_outcomes=119` (+6 in 24h, vs +33 the previous day; cron healthy, just lower outcome volume).
> - `provider_market_snapshots`: ✅ resumed at full pace — 8,711,852 (+2.1M vs 2026-05-04 frozen 6,595,519); the 2026-05-03→04 stall was a real observer pause, now caught up.
> - Polymarket indexer (W1): tables exist and are service-role-locked; `poly_wallet_trades=0` (no live writer until W2 ships).
>
> **(c) 7-day continuous-quote test on Kalshi PROD** (ADR-012 clock state):
> - Status: **IN FLIGHT** (day 3 of 7, ~hour 64 of 168 elapsed). 🚨 **At-risk: criterion "continuous quoting on ≥1 market" fails any rolling 1h window since 03:15Z today.** Operator restart of `pmci-mm-runtime` (or admin trigger that re-syncs depth subscriptions to the rotator-current universe) is the unblock.
> - **T0 = 2026-05-02T22:37:20.567Z** (first PROD-mode order id 55169, KXNBA-26-OKC yes_buy @ 54c).
> - **Expires: 2026-05-09T22:37:20Z.**
> - Live config: **8 markets enabled** (rotator-managed, refreshed daily). Today's universe: `KXNHLSERIES-26MINCOLR2-MIN`, `KXNBAGAME-26MAY08SASMIN-SAS`, `KXMLBTOTAL-26MAY041940CINCHC-10`, `KXPGATOUR-ONMBC26-BHOR`, `KXMETGALA-26-DUA`, 3× BTC monthly (`KXBTCMAXMON-BTC-26MAY31-{8500000,8750000,9000000}`). All carry vestigial `notes: "rotator-managed mode=demo …"` even though `kalshiEnv.runMode=prod` — M.5 in `de5fbc3` was supposed to fix the rotator's mode-resolution but the notes string didn't get updated. Cosmetic but worth flagging because next-session diagnostic might mistake it for a DEMO-mode runtime.
> - Spec per ADR-012: $5/day portfolio loss cap, $30 notional position cap, min_half_spread=2c, toxicity=200, stale_quote=300s.
> - Verdict at hour 168: pending. Track: net PnL ($−0.78 cumulative), continuous-quote criterion (currently breaking — 11h gap), fill ratio trend (last live 24h was 8.7%).
>
> **(c-prior) Historical: 7-day DEMO clock (ADR-008/010) PAUSED early 2026-05-02:** clock ran ~hour 92 of 168. Daily-loss criterion already RECORDED-FAIL on day 2 (44k events, PnL=−2,341.66c vs configured 2000c). Useful plumbing data, not strategy data — superseded by ADR-012 PROD clock.
>
> Arb thesis closed RED 2026-04-24; closed-pivot archive at `docs/archive/pivot-2026-04/` is reference-only — do not revive on this provider pair.

See `docs/architecture.md` for system structure.

## Knowledge Vault (Obsidian)

Compiled wiki for this project lives at `~/Documents/Claude/Projects/Prediction Machine/` (Karpathy LLM-wiki pattern). Read pre-compiled context from there before re-deriving from source.

Entry points:
- `_home.md` — dashboard, active phase, recent decisions
- `10-architecture/system-overview.md` — one-page mental model
- `20-database/_index.md` — schema gotchas + per-table pages
- `50-api/_index.md` — `/v1/*` reference
- `70-agents/_index.md` — agent specs
- `80-phases/_index.md` — phase status
- `90-decisions/_index.md` — ADRs (mirrors `docs/decision-log.md`)
- `95-runbooks/_index.md` — operational procedures
- `95-runbooks/seven-day-validation.md` — **load-bearing for the active phase**: pre-flight → T-0 → daily check-ins → verdict at hour 168. Read this before declaring any continuous-run "passed" or restarting a paused clock.

After significant code/schema changes: update the relevant wiki page and bump `last-verified` in its frontmatter. Source snapshots in `99-sources/` are immutable — re-snapshot explicitly.

### Post-MM strategic anchors (load-bearing, do not ignore)

These two documents define the strategic frame for everything that comes after the MM 7-day validation. A fresh agent has no way to derive this context from the code, so read them before making any scope-shaping decisions about post-MM work:

- `~/Documents/Claude/Projects/Prediction Machine/path-comparison-orchestrator-brief-2026-04-27.md` — locks the generalist-with-service-focus creative path and **explicitly forbids folding design / marketing-surface work into the MM technical build during Phase 0**. If you find yourself about to mix landing-page polish, motion graphics, or visualization design into an MM workstream, stop and re-read this brief. Visual capture during MM is *capture-only*; polished work is Phase 1.
- `~/Documents/Claude/Projects/Prediction Machine/roadmap-mm-to-creative-practice-2026-04-27.md` — the operational roadmap from current MM state through an interactive-SaaS-visualization practice. Phase 0 (now → ~Month 6) keeps the MM technical track unchanged; later phases relaunch PMCI publicly and open for outside work. Use this as the post-MM source of truth; it supersedes earlier `unified-12mo-plan-2026-04-27.md`.


## Repo Orientation

`prediction-machine` is the PMCI backend. It owns ingestion, normalization, matching, schema, and the active machine-facing API.

For current phase status (what's merged, what's persisting, where the 7-day clock stands), see the three-axis block at the top of this file. Repo-orientation context not covered there:

- **MM runtime operational state.** `pmci-mm-runtime.fly.dev` is in W4 reconcile phase against Kalshi DEMO. Polymarket indexer W2 (live ingestion via `pmci-poly-indexer` Fly app + Polygon RPC + subgraph) is the next workstream once the MM clock closes.
- **Reusable carryovers from the closed arb pivot.** `lib/resolution/` (originally pivot A1, now powering the MM resolution-driver) and `lib/execution/fees.kalshi.mjs::kalshiFeeUsdCeilCents` (used by W6 P&L attribution per Contract R7). These two modules survived the pivot close-out and are load-bearing for current MM accounting.
- **Prior validated milestones (historical anchors).** E1.6 sports validated 2026-04-14. The arb-pivot RED terminal call (2026-04-24) is the boundary event — see `docs/archive/pivot-2026-04/` for reference, the arb-closed invariant below for live-code guidance.

## Deployment (Fly.io — ACTIVE PRODUCTION)

Both apps are live on Fly.io. All secrets are set. Do not use PM2 or local `node` processes as the production runtime.

| App | URL | Config | Role |
|-----|-----|--------|------|
| `pmci-api` | `https://pmci-api.fly.dev` | `deploy/fly.api.toml` | Fastify API (`src/api.mjs`); admin `/v1/mm/*` routes for runtime dashboard |
| `pmci-observer` | `https://pmci-observer.fly.dev` | `deploy/fly.observer.toml` | Observer loop (`observer.mjs`) |
| `pmci-mm-runtime` | `https://pmci-mm-runtime.fly.dev` | `deploy/fly.mm.toml` | MM orchestrator (`scripts/mm/run-mm-orchestrator.mjs`); single-instance invariant, `/health/mm` endpoint |

- Deploy: `fly deploy --remote-only --config deploy/fly.api.toml` (or `fly.observer.toml`)
- Logs: `fly logs -a pmci-api` / `fly logs -a pmci-observer`
- Secrets: `fly secrets list -a pmci-api` / `fly secrets list -a pmci-observer`
- Health check: `curl -sS https://pmci-api.fly.dev/v1/health/freshness | jq .`
- Cron jobs run via Supabase Edge Functions (`supabase/functions/pmci-job-runner/`) — NOT via local PM2
- New cron jobs: add entry to `JOB_MAP` in `supabase/functions/pmci-job-runner/index.ts` + apply migration adding pg_cron row

### MM admin endpoints (on `pmci-api`)

All `/v1/mm/*` routes are mounted via `src/routes/mm-dashboard.mjs` and require the `X-PMCI-API-KEY` header (auth enforced in `src/server.mjs`). They are the runtime dashboard's read surface for the MM orchestrator and the source of truth for status checks — grep here before re-deriving from source:

| Route | Purpose |
|-------|---------|
| `GET /v1/mm/markets` | enabled markets + ticker rotator state |
| `GET /v1/mm/orders` | recent order book activity |
| `GET /v1/mm/positions` | current inventory by market |
| `GET /v1/mm/pnl` | P&L attribution (W6 / Contract R7) |
| `GET /v1/mm/fills` | recent fills |
| `GET /v1/mm/kill-switch-events` | kill-switch trip history (watch this for the 44k anomaly) |

Quick check: `curl -sS -H "X-PMCI-API-KEY: $PMCI_API_KEY" https://pmci-api.fly.dev/v1/mm/markets | jq .`

## Invariants

- Do not auto-write to `.env`; only print proposed changes.
- Do not bulk-inactivate markets without running the inactive-guard check first.
- Do not skip `npm run verify:schema` after any migration.
- Do not add new PMCI routes to root `api.mjs`; use `src/api.mjs` only.
- All new categories must use the guard-first proposer + strict-audit gate loop.
- **Active markets only for the observer and proposer.** Historical/settled market ingestion is permitted *only* via `lib/resolution/` (the resolution-outcome path, originally built as pivot A1; reusable for MM settlement accounting). Scoped to closed markets belonging to currently-linked families; writes to the dedicated `market_outcomes` dataset. Do not extend this exception to the observer, proposer, or any other ingestion code without explicit owner sign-off.
- **Arb thesis is closed on Kalshi+Polymarket (RED, 2026-04-24).** Do not reintroduce arb-pivot code, plans, or rubrics onto this branch. Do not apply Lever D (NHL/MLB alias map), classifier finer-bucket subdivision, or A3/A5 re-runs. If a future provider pair becomes interesting, start from `docs/archive/pivot-2026-04/` as reference, not as a live workspace.
- **MM single-instance.** `pmci-mm-runtime` must run with `fly scale count 1`. Two orchestrators would double-quote and break inventory accounting. Pause MM via `fly scale count 0 -a pmci-mm-runtime`.
- **Polymarket no-trade invariant (ADR-009).** New code under `lib/poly-indexer/` must go through the read-only client namespace at `lib/poly-indexer/clients/`; CI guard `npm run lint:poly-write-guard` (script `scripts/lint/no-polymarket-write.mjs`) enforces this. Do not add HTTP write paths to Polymarket APIs anywhere in the repo.
- **Cron writers are not "fixed" until DB writes are verified.** A cron returning HTTP 200 / "success" is necessary but not sufficient. A cron is fixed only when DB rows show up in the expected interval (≥30 min observation window, or one full cron cycle, whichever is longer). The validation query — the SQL that proves rows are landing — ships in the same commit as the migration / cron change, not as an afterthought. This pattern (the audit's §6 Pattern 4 "fire-and-forget operational dispatch") has fired at least twice on this branch: once with `_job_runner_url()` missing, once with the PnL writer + post-fill backfill returning success and writing zero rows. Apply to every cron-fired writer, every Edge Function in `supabase/functions/pmci-job-runner/`, and any new entry added to `JOB_MAP`.
- **PMCI is PROD-only since 2026-05-02 ADR-012 cutover.** Never invoke the rotator with `--mode=demo`. If a PROD path errors (rate limit, validator, encoding), fix the PROD path — do not fall back to DEMO. The script filename `scripts/mm/rotate-demo-tickers.mjs` is historical (originated DEMO-only); it now handles both modes via env. Default mode is PROD. DEMO is opt-in for legacy testing only. The pre-2026-05-02 DEMO clock under ADR-008/010 is paused/closed history — never refer to it as the live test.
- **Local `.env` PMCI_ADMIN_KEY + KALSHI_PROD_* must match Fly secrets** (`fly secrets list -a pmci-mm-runtime` and `fly secrets list -a pmci-api`). Pre-flight before any rotator-driven `/admin/restart`: a local-vs-Fly mismatch returns 403 and silently breaks the rotator's runtime-restart step → depth feeds get stuck on stale subscriptions for hours (35h dormancy incident, 2026-05-05). Sync via `fly secrets set <KEY>=<value>` from the source of truth, not the other way.
- **MM_RUN_MODE=prod must be set on BOTH `pmci-api` AND `pmci-mm-runtime` Fly apps.** They are separate apps with separate secrets. `pmci-api` spawns the rotator subprocess via `/v1/admin/jobs/*` admin routes, so its env determines rotator mode for cron-driven runs. `pmci-mm-runtime` runs the orchestrator. A missing `MM_RUN_MODE=prod` on `pmci-api` makes cron rotations default to DEMO even when everything else is configured PROD.

## Key Entrypoints

- `observer.mjs` — continuous observer runtime
- `src/api.mjs` — active PMCI API entrypoint
- `src/server.mjs` — server bootstrap and route wiring
- `lib/ingestion/universe.mjs` — universe ingest path
- `lib/matching/proposal-engine.mjs` — proposal generation and scoring
- `lib/providers/kalshi.mjs` — Kalshi API client
- `lib/providers/polymarket.mjs` — Polymarket API client
- `lib/resolution/` — pivot A1 settlement fetch + `npm run pmci:ingest:outcomes` (linked sports only)
- `supabase/migrations/` — schema history
- `docs/roadmap.md` — phase-by-phase roadmap
- `docs/system-state.md` — live system state and known risks
- `docs/decision-log.md` — architectural decisions
- `docs/plans/phase-e1-sports-plan.md` — detailed Phase E1 plan
- `docs/db-schema-reference.md` — **DB column reference and API auth; read at session start before any DB queries or API calls**
- `docs/plans/workflow-optimization-plan.md` — agentic workflow decisions (process patterns, agent split, gate verification)
- `docs/archive/pivot-2026-04/` — closed arb pivot (RED terminal 2026-04-24). Reference only; do not revive without a new provider pair.

## Supabase Project

- **Project name:** Prediction Machine
- **Project ref:** `awueugxrdlolzjzikero`
- **Region:** us-east-1
- **Status:** ACTIVE_HEALTHY
- Use ref `awueugxrdlolzjzikero` directly with the Supabase MCP — no need to call `list_projects` to find it.

## Verification Commands

```bash
npm run pmci:smoke
npm run pmci:probe
npm run verify:schema
npm run pmci:check-coverage
```
