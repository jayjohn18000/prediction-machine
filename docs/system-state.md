# System State

## Branch
- `chore/infra-hardening-baseline-2026-02-26`

## Current Status
- Baseline schema + smoke + coverage checks passing.
- SLO endpoint implemented and returning structured check payload.
- `scripts/pmci-bootstrap.mjs` fully implemented (Tasks 1–6): env load, DB connect, provider ID check, markets/snapshots/families/links/freshness checks, final summary.
- `/v1/health/projection-ready` endpoint fully implemented (Tasks 7–9): aggregated SQL, per-check pass/fail, `missing_steps`, 503 on DB error.
- Live bootstrap run (2026-03-02): all five checks green — 1336 markets, 289k+ snapshots, 61 families, 122 active links, freshness 30s.
- `npm run bootstrap` script wired in `package.json`.
- **PMCI linkage pipeline fixes (2026-03-03):**
  - `parsePolyRef`: adds title-based entity fallback for numeric/Yes-No outcomeName (Polymarket universe markets)
  - `extractTopicSignature`: governor+senate checks now run BEFORE presidential nominee check
  - `considerPair`: adds `sameBlockBonus=0.35` for same specific-signature + last-name-match pairs → brings cross-venue confidence to 0.92 (pending proposal threshold)
  - `pmci-politics-insights.mjs`: coverage calls now omit `&category=politics` → reports 12.6% Kalshi / 7.2% Polymarket instead of 0%
  - `seed-pmci-families-links.mjs`: seeds 3 additional canonical events (presidential-election-winner-2028, which-party-wins-2028-us-presidential-election, who-will-trump-nominate-as-fed-chair)
  - Canonical events: 2 → 5 after re-running `npm run seed:pmci`

## Known Risks
- Existing repository has unrelated in-flight local changes (not yet committed).
- Freshness threshold differs between CLI (`PMCI_MAX_LAG_SECONDS` default 180s) and API (default 120s) — intentional but worth documenting if operators see inconsistency.
- Polymarket universe DEM/REP 2028 nominee markets use "Person X" placeholder names for many slots — entity-based matching can only link markets with real candidate names in the title. Coverage expansion requires Polymarket to fill these placeholders.
- `coverage/summary` endpoint with no category filter counts all provider_markets (including non-politics if future ingestion adds them). Currently safe: all 1336 markets are political.

## Next Actions
1. **Re-run universe ingestion** — `npm run pmci:ingest:politics:universe` to refresh Polymarket DEM/REP 2028 data; as Polymarket fills "Person X" placeholders with real names, more cross-venue pairs become linkable.
2. **Run review queue** — `npm run pmci:review` to review any pending proposals (currently 0, but will grow as named Polymarket markets appear).
3. **Expand event_pairs.json** — add newly discovered DEM/REP 2028 nominee tickers from Kalshi universe to event_pairs.json and re-run `npm run seed:pmci` to formally link them.
4. **Commit** — stage and commit all changes on `chore/infra-hardening-baseline-2026-02-26`.
