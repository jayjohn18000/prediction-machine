# Prediction Machine — Claude Context

> **CURRENT PHASE (2026-05-02): MM MVP 7-day validation, day 4 of 7.**
>
> Status is tracked across three independent axes. Conflating them produces "we shipped" claims that survive only until the next status check.
>
> **(a) Code merged** (binary, verify from git):
> - MM Pre-W2 + W2–W6 merged 2026-04-28 (W6 closed feature-complete).
> - MM triage A (PnL+positions), B (depth feed), C (order reconciler) merged 2026-04-29.
> - Daily ticker rotator + 24h heartbeat verifier merged 2026-04-30.
> - Tracks B (B.1–B.8 arb sunset cleanup), C (MM v2 prep docs at `docs/plans/mm-v2/`), D (open-decisions Q1–Q8 with operator answers), E (runtime triage memo) all merged 2026-05-01.
> - Tracks F (F.1–F.5 MM runtime fixes: `lastStartupReconcileAt` rename, PnL daily-net fix, structured Kalshi error capture, `mm_orders.status` lifecycle + backfill, `/health/mm` `ready`/`severity` composite), H (reconcile-timeout hotfix), I (Kalshi DEMO WS spaced subscribes), J (WS heartbeat + per-ticker staleness watchdog) all merged 2026-05-01 → 2026-05-02. HEAD = `1777db1`.
> - Polymarket indexer Pre-W1 + W1 merged 2026-04-28 (ADR-009: read-only `lib/poly-indexer/clients/`, CI lint guard `npm run lint:poly-write-guard`, `lib/poly-indexer/reorg.mjs`, migration `20260430130000_pmci_poly_w1.sql`, all 4 `poly_*` tables service-role only).
> - Polymarket indexer W2 (live Polygon ingestion via `pmci-poly-indexer` Fly app) NOT started.
>
> **(b) Writers verified persisting** (DB rows in expected intervals — Pattern 4 of the audit):
> - `pmci-mm-runtime` health endpoint: ⚠️ runtime restarted at `2026-05-02T12:17:09Z` (likely Track J redeploy). At T+0 reported `ready=false`, `severity=crit`, `loopTick=0`, `depthSubscribedConnected=0/8`. At T+2min recovered to `severity=warn`, `loopTick=22`, depth `8/8` connected, `lastReconcileAt` advancing — warm-up appears nominal. Track F's new readiness fields are doing their job (surfaces real warm-up state instead of false `ok=true`). Watch the next probe to confirm steady-state.
> - Orders / fills writers: ✅ persisting — `mm_orders` 24h=4,511 / 1h=16 (2026-05-02 12:17Z; 1h sample is during warm-up window after restart); `mm_fills` 24h=42 (~0.93% of orders, within healthy band 0.1%–10%). Lifetime `mm_orders=49,864`, `mm_fills=157`.
> - `kill_switch_events`: ✅ 24h delta = **0** — storm has stayed stopped since 2026-04-30T13:43Z. Cumulative still 44,372 (all `reason=daily_loss` from the 2026-04-29/30 storm). Daily-loss exit-criterion breach on day 2 stands as the controlled-failure observation; not declared PASS at hour 168 on this dimension.
> - PnL writer + post-fill backfill: ✅ both verified persisting (2,304 PnL snapshots in 24h on 2026-05-02; latest snapshot `2026-05-02T12:15:02Z`).
> - `mm_orders.status` propagation: ✅ Track F.4 backfill landed — lifetime `status='filled'` count = 127 (was 0 on 2026-05-01).
> - `_job_runner_url()` lookup: still working (PnL snapshot every 5min cadence holding).
> - Polymarket indexer (W1): tables exist and are service-role-locked; `poly_wallet_trades` count = 0 (no live writer until W2 ships).
>
> **(c) 7-day continuous-quote test on Kalshi DEMO** (ADR-008/010 clock state):
> - Status: **IN FLIGHT** (day 4 of 7; ~hour 91 of 168).
> - Started: **2026-04-28T17:41:28.638Z** (ADR-008).
> - Expires: **~2026-05-05T17:41Z**.
> - Live config: 8 enabled markets + daily ticker rotator (drift from ADR-008's static 5; documented retroactively in **ADR-010**, 2026-05-01).
> - Verdict at hour 168: pending. Daily-loss criterion already breached on day 2; do not declare full PASS.
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
