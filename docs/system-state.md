# System State

## Legacy vs active runtime surfaces
- **Active PMCI API:** `src/api.mjs` (Fastify). Run with `npm run api:pmci` (or `npm run api:pmci:dev`). Serves `/v1/health/*`, `/v1/coverage*`, `/v1/markets/*`, `/v1/market-families`, `/v1/market-links`, `/v1/signals/*`, `/v1/review/*`, `/v1/resolve/link`.
- **Legacy API:** Root `api.mjs` (Node HTTP). Run with `npm run api` (or `npm run api:dev`). Execution-intelligence endpoints only (`/signals/top`, `/execution-decision`, `/routing-decisions/top`). Deprecated in favor of `src/api.mjs` for PMCI; this file is retained for execution-signal use until a sunset milestone. Do not add new PMCI routes here.

## Observer frontier (v2) — env reference
DB-backed pair discovery replaces mandatory large static JSON when enabled.

| Env | Meaning |
|-----|---------|
| `OBSERVER_DB_DISCOVERY=1` | Each cycle, merge capped SQL frontier from `pmci.market_links` (`lib/ingestion/observer-frontier.mjs`) |
| `OBSERVER_USE_DB_FRONTIER_ONLY=1` | Ignore static file; pairs = DB frontier only (still requires `OBSERVER_DB_DISCOVERY=1` behavior) |
| `OBSERVER_ALLOW_EMPTY_STATIC=1` | Allow `[]` in `scripts/prediction_market_event_pairs.json` when using DB merge |
| `OBSERVER_MAX_PAIRS_PER_CYCLE` | Cap DB rows per cycle (default 500) |
| `OBSERVER_CATEGORY_ALLOWLIST` | Optional comma list; both Kalshi and Poly `provider_markets.category` must match |
| `OBSERVER_INCLUDE_PROXY_LINKS=1` | Include `proxy` links in frontier (default: `equivalent` only) |
| `PMCI_SWEEP_PRIORITIZE_LINKED=1` | PMCI sweep orders stale markets so linked `provider_markets` refresh first (`lib/ingestion/pmci-sweep.mjs`) |

## Script ownership boundaries
- `api:pmci*` scripts own PMCI `/v1/*` runtime behavior.
- `api*` scripts (without `:pmci`) are legacy execution API only.
- `start` / `observe:spreads` own observer ingestion loop execution.
- `pmci:*` scripts are PMCI operational workflows (ingest/probe/smoke/review/audit/check), not API server entrypoints.

---

## Current status (2026-04-17)

- **Branch / phase:** `main`; **E2** (crypto) and **E3** (economics) in progress — ladder-style crypto proposer, economics event-group proposer, full review pipeline wired for admin/cron (`scripts/review/pmci-review-category-pipeline.mjs`).
- **Production:** `pmci-api` and `pmci-observer` on Fly.io (see `deploy/fly.api.toml`, `deploy/fly.observer.toml`). Cron and scheduled jobs use Supabase `pmci-job-runner` Edge Function + `pg_cron`, not local PM2.
- **Ops:** `npm run pmci:status` — API health plus, when `DATABASE_URL` is set, smoke counts, pending proposals by category, active links by category, and latest observer heartbeat. `npm run pmci:smoke` remains the lightweight DB smoke check.
- **Automation:** pg_cron jobs include ingest (sports/politics), stale cleanup, schema verify, audit, crypto/economics review pipelines (full propose → auto-accept → audit), daily status digest, weekly coverage benchmark (apply latest migrations for digest/benchmark schedules).

### Carry-forward (see `docs/adr/` for design gates)
- Polymarket strike ladders vs Kalshi: tolerance and product rules (ADR: ladder strike tolerance).
- Ladder / multi-strike divergence scoring vs binary YES mid (`signals/top-divergences`) — Phase F design (ADR: ladder divergence scoring).
- Canonical event lifecycle after settlement (archive vs delete) — ADR: canonical event lifecycle.

### Known risks (abbreviated)
- Freshness thresholds differ between CLI and API by design; align operator expectations via `PMCI_MAX_LAG_SECONDS` / API config.
- Competitive coverage and benchmark outputs live under `output/benchmark/`; weekly cron archives there when the benchmark job runs on a host with `DATABASE_URL` and optional `ODDPOOL_API_KEY`.

---

## Historical detail

Older dated snapshots, sprint tables, and phase-by-phase closeouts were removed from this file to reduce drift. Use git history for prior `system-state.md` content if you need a specific dated snapshot.
