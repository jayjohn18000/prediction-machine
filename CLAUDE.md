# Prediction Machine — Claude Context

## What this project is
Cross-platform prediction market intelligence platform. Ingests, normalizes, and cross-links markets from **Kalshi** and **Polymarket** into a canonical intelligence layer (PMCI — Prediction Market Canonical Intelligence). Backend: Node.js ESM + Fastify + Supabase/Postgres + Caddy (TLS).

## Current phase: Phase E1 — Sports Expansion
- Phases A (stability), B (reliability), C (M2M API), D (politics normalization) are **complete**
- Phase E1 is the active work: onboarding sports markets (NFL, NBA, MLB) using the same guard-first proposer + strict-audit gate loop from Phase D
- Phase E2 (crypto) follows E1

## Runtime entrypoints
- **Observer loop:** `npm run start` — ingests spreads + PMCI snapshots continuously
- **PMCI API:** `npm run api:pmci` — Fastify, port 8787, serves `/v1/*`
- **Legacy API:** `npm run api` — deprecated Node HTTP, execution-intelligence endpoints only

## Key files
- `src/api.mjs` — active PMCI API entrypoint (Fastify)
- `src/server.mjs` — server setup, freshness cache, CORS
- `lib/ingestion/universe.mjs` — universe ingest for Kalshi + Polymarket
- `lib/matching/proposal-engine.mjs` — proposal generation and scoring
- `lib/providers/kalshi.mjs` — Kalshi API client
- `lib/providers/polymarket.mjs` — Polymarket API client
- `observer.mjs` — spread observer loop
- `supabase/migrations/` — all schema migrations (read before any schema change)
- `event_pairs.json` — paired Kalshi↔Polymarket market config
- `config/pmci-politics-series.generated.json` — auto-generated Kalshi series list
- `docs/roadmap.md` — phase-by-phase roadmap with acceptance criteria
- `docs/system-state.md` — current live system state and known risks
- `docs/decision-log.md` — key architectural decisions and rationale
- `docs/plans/phase-e1-sports-plan.md` — Phase E1 detailed plan

## PMCI data model
- `pmci.provider_markets` — one row per market per provider (category, election_phase, subject_type)
- `pmci.provider_market_snapshots` — price snapshots per cycle
- `pmci.canonical_events` — normalized event (e.g. "2028 Democratic Nominee")
- `pmci.market_families` — groups equivalent markets across providers
- `pmci.market_links` — specific provider market ↔ family membership
- `pmci.proposed_links` — review queue for unconfirmed cross-platform pairs
- `pmci.observer_heartbeats` — observer liveness

## Current data state
- 2,814 provider_markets (557 Kalshi, 2,257 Polymarket)
- 7 canonical events (all politics — 2028 Dem + Rep nominees active)
- 138 active cross-platform links
- All SLOs green: ingestion_success=1.00, p95=124ms, freshness <120s

## Invariants (never violate)
- Do not auto-write to `.env` — only print proposed changes to stdout
- Do not bulk-inactivate markets without running the inactive-guard check first
- Do not skip `npm run verify:schema` after any migration
- Do not add new PMCI routes to root `api.mjs` — use `src/api.mjs` only
- All new categories must use guard-first proposer + strict-audit gate loop
- Active markets only — no historical/settled market ingestion (Option A policy, 2026-03-06)

## Verification sequence (run in order)
```bash
npm run pmci:smoke           # DB connectivity + basic table counts
npm run pmci:probe           # schema health + coverage dashboard
npm run verify:schema        # confirms required columns/views exist
npm run pmci:check-coverage  # API coverage endpoint shape check (API must be running)
```

## Agent roles (orchestration)
- **Claude (Cowork/Dispatch):** orchestration, git commits, browser automation, API probing via curl/Bash, file creation, reading docs, task dispatch
- **OpenClaw (Plumbo):** code editing in Cursor, creating/modifying scripts and migrations, running terminal commands within the IDE, multi-file refactors

## Phase D follow-on (non-blocking, run during E1)
- Governor coverage lift: 0.067 → target ≥ 0.20 (D6 gate not yet met)
- Observer continuity improvements
