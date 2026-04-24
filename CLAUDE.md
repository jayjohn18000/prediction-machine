# Prediction Machine — Claude Context

> **ACTIVE PIVOT (2026-04-19): Realized-edge backtest.** The project is paused on category expansion (E2 crypto, E3 economics) and refocused on producing a ranked per-family net-P&L table against historical snapshot data. Read `docs/pivot/north-star.md` before starting any work. E2/E3 and new-provider onboarding are explicitly out of scope until the backtest decision lands. See `docs/pivot/dependency-map.md` for what's in scope and what's not.

See `docs/architecture.md` for system structure.

## Knowledge Vault (Obsidian)

Compiled wiki for this project lives at `~/Obsidian/Prediction Machine/` (Karpathy LLM-wiki pattern). Read pre-compiled context from there before re-deriving from source.

Entry points:
- `_home.md` — dashboard, active phase, recent decisions
- `10-architecture/system-overview.md` — one-page mental model
- `20-database/_index.md` — schema gotchas + per-table pages
- `50-api/_index.md` — `/v1/*` reference
- `70-agents/_index.md` — agent specs
- `80-phases/_index.md` — phase status
- `90-decisions/_index.md` — ADRs (mirrors `docs/decision-log.md`)
- `95-runbooks/_index.md` — operational procedures

After significant code/schema changes: update the relevant wiki page and bump `last-verified` in its frontmatter. Source snapshots in `99-sources/` are immutable — re-snapshot explicitly.


## Repo Orientation

`prediction-machine` is the PMCI backend. It owns ingestion, normalization, matching, schema, and the active machine-facing API.

Current active phase: **Pivot to Realized Edge** (started 2026-04-19) — historical-backtest-driven go/no-go on a guarded live pilot. E2/E3 parallel expansion is paused. See `docs/pivot/north-star.md`. Prior milestone for reference: E1.6 validated 2026-04-14.

## Deployment (Fly.io — ACTIVE PRODUCTION)

Both apps are live on Fly.io. All secrets are set. Do not use PM2 or local `node` processes as the production runtime.

| App | URL | Config | Role |
|-----|-----|--------|------|
| `pmci-api` | `https://pmci-api.fly.dev` | `deploy/fly.api.toml` | Fastify API (`src/api.mjs`) |
| `pmci-observer` | `https://pmci-observer.fly.dev` | `deploy/fly.observer.toml` | Observer loop (`observer.mjs`) |

- Deploy: `fly deploy --remote-only --config deploy/fly.api.toml` (or `fly.observer.toml`)
- Logs: `fly logs -a pmci-api` / `fly logs -a pmci-observer`
- Secrets: `fly secrets list -a pmci-api` / `fly secrets list -a pmci-observer`
- Health check: `curl -sS https://pmci-api.fly.dev/v1/health/freshness | jq .`
- Cron jobs run via Supabase Edge Functions (`supabase/functions/pmci-job-runner/`) — NOT via local PM2
- New cron jobs: add entry to `JOB_MAP` in `supabase/functions/pmci-job-runner/index.ts` + apply migration adding pg_cron row

## Invariants

- Do not auto-write to `.env`; only print proposed changes.
- Do not bulk-inactivate markets without running the inactive-guard check first.
- Do not skip `npm run verify:schema` after any migration.
- Do not add new PMCI routes to root `api.mjs`; use `src/api.mjs` only.
- All new categories must use the guard-first proposer + strict-audit gate loop.
- **Active markets only for the observer and proposer.** Historical/settled market ingestion is permitted *only* via the pivot's resolution-outcome path (see `docs/pivot/agents/a1-resolution-ingestion.md`), which is scoped to closed markets belonging to currently-linked families and writes to a dedicated `market_outcomes` dataset. Do not extend this exception to the observer, proposer, or any other ingestion code without explicit owner sign-off.

## Pivot guardrails (active while the pivot is in progress)

- Do not start or resume E2 (crypto) or E3 (economics) ingestion, proposer, or audit work.
- Do not onboard new providers (DraftKings, Manifold, Myriad, Limitless, Metaculus, PredictIt).
- Do not tune classifier / matcher / proposer / slot code to chase unlinked-slot coverage.
- Do not clean up files outside `docs/pivot/` during the pivot.
- Do not merge pivot work to `main` until the artifact integrates with the ranked per-family P&L table (the pivot's scoreboard).

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
- `docs/pivot/north-star.md` — **pivot scoreboard; every pivot agent reads this first**
- `docs/pivot/dependency-map.md` — pivot agent parallelism, critical path, out-of-scope register
- `docs/pivot/success-rubric.md` — GREEN/YELLOW/RED decision zones for backtest output
- `docs/pivot/agents/` — per-agent briefs (A1 resolution ingestion, A2 cost model, A3 equivalence audit, A4 execution-account readiness, A5 backtest engine)
- `docs/pivot/cursor-prompt.md` — short launch prompt for Cursor parallel agents

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
