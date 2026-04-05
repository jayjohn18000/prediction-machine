# Prediction Machine — Claude Context

See `docs/architecture.md` for system structure.

## Repo Orientation

`prediction-machine` is the PMCI backend. It owns ingestion, normalization, matching, schema, and the active machine-facing API.

Current active phase: Phase E1 — sports expansion.

## Invariants

- Do not auto-write to `.env`; only print proposed changes.
- Do not bulk-inactivate markets without running the inactive-guard check first.
- Do not skip `npm run verify:schema` after any migration.
- Do not add new PMCI routes to root `api.mjs`; use `src/api.mjs` only.
- All new categories must use the guard-first proposer + strict-audit gate loop.
- Active markets only; no historical/settled market ingestion.

## Key Entrypoints

- `observer.mjs` — continuous observer runtime
- `src/api.mjs` — active PMCI API entrypoint
- `src/server.mjs` — server bootstrap and route wiring
- `lib/ingestion/universe.mjs` — universe ingest path
- `lib/matching/proposal-engine.mjs` — proposal generation and scoring
- `lib/providers/kalshi.mjs` — Kalshi API client
- `lib/providers/polymarket.mjs` — Polymarket API client
- `supabase/migrations/` — schema history
- `docs/roadmap.md` — phase-by-phase roadmap
- `docs/system-state.md` — live system state and known risks
- `docs/decision-log.md` — architectural decisions
- `docs/plans/phase-e1-sports-plan.md` — detailed Phase E1 plan

## Verification Commands

```bash
npm run pmci:smoke
npm run pmci:probe
npm run verify:schema
npm run pmci:check-coverage
```
