# PMCI Live Roadmap Audit — 2026-04-12

## Summary
- Overall status: mixed, mostly on-track.
- E1.5 remains complete in code/runtime evidence; E2 is next.
- Phase F remains planning-only (no execution-readiness routes/services implemented yet).

## Evidence-first findings
- `git status --short --branch`: `main...origin/main [ahead 7]`, working tree contains unrelated workflow/doc/script edits.
- `npm run verify:schema`: PASS.
- `npm run pmci:smoke`: provider_markets=80375, snapshots=816206, families=3120, current_links=131.
- `find src/routes` + route/service probes: active PMCI routes include `signals/divergence` and `signals/top-divergences`; no `/v1/signals/ranked` or `/v1/router/best-venue`; no `src/services/tradability-service.mjs` or `config/execution-readiness.json`.

## Drift notes
- Docs needed smoke/count refresh from 2026-04-10 snapshots to 2026-04-12 rerun values.
- Phase F planning docs remain valid as intent, but not implementation claims.

## Next moves
1. Start E2 crypto schema + ingestion slice with deterministic checks.
2. Keep Phase F documents labeled planning-only until routes/services exist in `src/*`.
3. Continue live-audit refresh cadence when smoke/probe outputs materially change.
