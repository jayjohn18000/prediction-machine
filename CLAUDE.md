# Prediction Machine — Claude Context

> **CURRENT PHASE (2026-05-03): PROD MM live capital, day 1 of 7 (ADR-012 clock).**
>
> Status is tracked across three independent axes. Conflating them produces "we shipped" claims that survive only until the next status check.
>
> **(a) Code merged** (binary, verify from git):
> - MM Pre-W2 + W2–W6 merged 2026-04-28 (W6 closed feature-complete).
> - MM triage A (PnL+positions), B (depth feed), C (order reconciler) merged 2026-04-29.
> - Daily ticker rotator + 24h heartbeat verifier merged 2026-04-30.
> - Tracks B/C/D/E (arb sunset cleanup, v2 prep docs, open decisions, triage memo) merged 2026-05-01.
> - Tracks F (F.1–F.5 MM runtime fixes), H (reconcile-timeout hotfix), I (Kalshi DEMO WS spaced subscribes), J (WS heartbeat + per-ticker staleness watchdog) all merged 2026-05-01 → 2026-05-02.
> - **2026-05-02 same-day cutover patch sweep + ADR-011 + ADR-012:** `/admin/restart` fail-closed, `/health/mm` 503-on-crit, `MM_RUN_MODE=prod` env switch (`lib/mm/kalshi-env.mjs`), `DEFAULT_MM_PARAMS_PROD` ($5/day, $30 notional via `deriveHardPositionLimit`), outcome-ingest cron, `mm_fills.kalshi_*_fee_cents` columns, RLS+revoke on poly partition children, intra-tick `kill_switch_active` re-read, idle-state liveness heartbeat, withdrawal runbook. Commits `f80c05b`, `66c1444`, `ff207c6`, `f6907ba`, `d62bff2`, `3302f5c`, `073528b`. **HEAD at start of 2026-05-03 update = `073528b`**.
> - Polymarket indexer Pre-W1 + W1 merged 2026-04-28 (ADR-009).
> - Polymarket indexer W2 (live Polygon ingestion via `pmci-poly-indexer` Fly app) NOT started.
>
> **(b) Writers verified persisting** (DB rows in expected intervals — Pattern 4 of the audit):
> - `pmci-mm-runtime` health endpoint: ✅ `ok=true ready=false severity=warn loopTick=950+ depth 7/7 connected runMode=prod` (2026-05-03 02:42Z). `severity=warn` is Track J's WS-staleness watchdog firing on `KXETHMINY-27JAN01-1250` (255s) and `KXLCPIMAXYOY-27-P4.5` (164s) — both new low-vol PROD tickers, expected behaviour, not actionable.
> - Orders / fills writers: ✅ persisting — lifetime `mm_orders=57,113` (+7,249 vs 2026-05-02 sync; PROD cutover absorbed most of that); lifetime `mm_fills=197` (+40); `mm_orders_24h=10,946`. **Since ADR-012 T0 (2026-05-02T22:37:20Z): 1,945 orders, 1 fill** (KXNBA-26-OKC yes_sell @ 57c, 02:26:41Z, fair_value_at_fill 55.4c, adverse_5m −2.11c).
> - `kill_switch_events`: ✅ 24h delta = **5** (well within healthy band; likely from the 30s stale-DEMO-rows window during cutover). Cumulative still 44,377 from the 2026-04-29/30 DEMO storm.
> - PnL writer + post-fill backfill: ✅ both verified persisting (188 PnL snapshots since T0 ≈ 5min cadence × 7 markets × 4h; latest snapshot `2026-05-03T02:40:00Z`).
> - `mm_orders.status` propagation: ✅ Track F.4 working (parent of fill 197 went `filled`).
> - `mm-ingest-outcomes` cron (new, ADR-011): ✅ first writes confirmed — `market_outcomes=109` (was 76 on 2026-05-02; +33 in 24h). Lane 14 cutover gate self-validated post-T0.
> - Polymarket indexer (W1): tables exist and are service-role-locked; `poly_wallet_trades=0` (no live writer until W2 ships).
>
> **(c) 7-day continuous-quote test on Kalshi PROD** (ADR-012 clock state):
> - Status: **IN FLIGHT** (day 1 of 7).
> - **T0 = 2026-05-02T22:37:20.567Z** (first PROD-mode order id 55169, KXNBA-26-OKC yes_buy @ 54c).
> - **Expires: 2026-05-09T22:37:20Z.**
> - Live config: **7 markets enabled** (mids 36–74c, spreads 1–6c). Original pair: `KXNBA-26-OKC`, `CONTROLS-2026-D` (both 1c PROD spread, low fill rate by design). Lane-12 v2 expansion at 01:13Z added 5 wider-spread tickers across diverse families: `KXMIDTERMMOV-MAGOVD-P26` (MA-gov margin), `KXWTIMAX-26DEC31-T135` (WTI ≥$135), `GOVPARTYAZ-26-D` (AZ-gov party=D), `KXETHMINY-27JAN01-1250` (ETH ≤$1250), `KXLCPIMAXYOY-27-P4.5` (CPI YoY ≥4.5%; HPL depth-capped to 9 contracts).
> - Spec per ADR-012: $5/day portfolio loss cap, $30 notional position cap, min_half_spread=2c, toxicity=200, stale_quote=300s.
> - Verdict at hour 168: pending. Anomaly to track: 24h fill ratio at 0.05% (1/1945) is BELOW the 0.1% healthy-band floor — expected for the original pair at 1c PROD spread; the 5 wider-spread additions should lift the ratio over the next 24h.
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
