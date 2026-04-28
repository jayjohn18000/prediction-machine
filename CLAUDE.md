# Prediction Machine — Claude Context

> **CURRENT PHASE (2026-04-24): Market Making MVP (scaffolding).** The realized-edge arb backtest closed RED terminal on 2026-04-24 — the Kalshi+Polymarket arb surface is structurally shallow, not tunable. Successor thesis is market making on Kalshi, with Polymarket on-chain data as an information source (no Poly execution; US-resident constraint). Closed-pivot archive: `docs/archive/pivot-2026-04/`. Do not revive the arb thesis on this provider pair.

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

After significant code/schema changes: update the relevant wiki page and bump `last-verified` in its frontmatter. Source snapshots in `99-sources/` are immutable — re-snapshot explicitly.


## Repo Orientation

`prediction-machine` is the PMCI backend. It owns ingestion, normalization, matching, schema, and the active machine-facing API.

Current active phase: **Market Making MVP** (scaffolding started 2026-04-24) — Kalshi-only order-book MM: fair-value model, inventory-aware quoting, new MM-specific backtest engine, adverse-selection tracking. Parallel workstream: Polymarket on-chain wallet indexer as information source (public Polygon data; no Polymarket account or trading). Reusable carryovers from the closed pivot: `lib/resolution/` (A1), `lib/execution/costs.mjs` (A2 — fees/lockup portion), `lib/backfill/polymarket-snapshot-recovery.mjs`, observer pattern. Prior milestones: E1.6 sports validated 2026-04-14; arb pivot closed RED terminal 2026-04-24 (see `docs/archive/pivot-2026-04/`).

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
- **Active markets only for the observer and proposer.** Historical/settled market ingestion is permitted *only* via `lib/resolution/` (the resolution-outcome path, originally built as pivot A1; reusable for MM settlement accounting). Scoped to closed markets belonging to currently-linked families; writes to the dedicated `market_outcomes` dataset. Do not extend this exception to the observer, proposer, or any other ingestion code without explicit owner sign-off.
- **Arb thesis is closed on Kalshi+Polymarket (RED, 2026-04-24).** Do not reintroduce arb-pivot code, plans, or rubrics onto this branch. Do not apply Lever D (NHL/MLB alias map), classifier finer-bucket subdivision, or A3/A5 re-runs. If a future provider pair becomes interesting, start from `docs/archive/pivot-2026-04/` as reference, not as a live workspace.

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
