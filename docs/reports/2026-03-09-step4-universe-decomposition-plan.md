# Step 4 — universe.mjs Decomposition Plan

**Date:** 2026-03-09
**Branch:** fix/review-idempotent-atomic-2026-03-08
**File under decomposition:** `lib/ingestion/universe.mjs` (~920 lines)

---

## Objective

Extract the monolith `universe.mjs` into focused, testable modules without changing runtime behaviour. Each slice must be behavior-preserving and independently committable.

---

## Inventory of concerns in universe.mjs

| # | Name(s) | Kind | Lines | Dependencies |
|---|---------|------|-------|--------------|
| A | `parseNum`, `clamp01` | Pure numeric helpers | 27–38 | none |
| B | `splitCsv`, `sleep` | Pure string/async helpers | 40–45, 23–25 | none |
| C | `inferElectionPhase`, `inferSubjectType` | Pure domain inference | 48–65 | none |
| D | `parseOutcomes`, `parseOutcomePrices`, `getDerivedPrice` | Pure price parsers | 399–445 | `clamp01`, `parseNum` |
| E | `fetchJson`, `fetchKalshiWithRetry` | HTTP utilities | 67–125 | `sleep` |
| F | `readKalshiCheckpoint`, `writeKalshiCheckpoint` | File-system I/O | 127–154 | `KALSHI_CHECKPOINT_PATH` const |
| G | `orderKalshiSeriesByLiveness` | DB query function | 156–198 | pmciClient |
| H | `ingestKalshiUniverse` | Kalshi orchestration | 200–397 | A, B, C, E, F, G, ingestProviderMarket |
| I | `ingestPolymarketUniverse` | Polymarket orchestration | 452–784 | A, B, C, D, E, ingestProviderMarket |
| J | `runUniverseIngest` | Top-level export | 791–920 | H, I, pmciClient, getProviderIds |

---

## Decomposition Plan (ordered by safety / dependency depth)

### Slice 1 — Price-parsing primitives (this commit)
**Extract A + D** into `lib/ingestion/services/price-parsers.mjs`.

- Functions: `parseNum`, `clamp01`, `parseOutcomes`, `parseOutcomePrices`, `getDerivedPrice`
- All pure, zero dependencies
- Used in both Kalshi and Polymarket sections of universe.mjs
- Add `test/ingestion/price-parsers.test.mjs` — pure unit tests, no DB, no network

### Slice 2 — Market metadata inference
**Extract C** into `lib/ingestion/services/market-metadata.mjs`.

- Functions: `inferElectionPhase`, `inferSubjectType`
- Pure, no deps
- Called in both providers during market record construction

### Slice 3 — Shared primitives
**Extract B** (sleep, splitCsv) into `lib/ingestion/services/utils.mjs` or merge into existing shared utility if one exists.

### Slice 4 — HTTP client
**Extract E** (`fetchJson`, `fetchKalshiWithRetry`, `sleep`) into `lib/ingestion/services/http-client.mjs`.

- Has one async util dep (sleep) — bring it along or import from Slice 3
- Makes retry logic independently testable (mock fetch)

### Slice 5 — Checkpoint repository
**Extract F** (`readKalshiCheckpoint`, `writeKalshiCheckpoint`, `KALSHI_CHECKPOINT_PATH`) into `lib/ingestion/repositories/kalshi-checkpoint.mjs`.

- Pure file I/O, no network, no DB
- Clear repository boundary

### Slice 6 — Series-liveness repository
**Extract G** (`orderKalshiSeriesByLiveness`) into `lib/ingestion/repositories/series-liveness.mjs`.

- Single DB query function, returns ranked series
- Accepts pmciClient as injection point — easy to mock for tests

### Slice 7 — Kalshi and Polymarket service modules
**Extract H + I** into `lib/ingestion/services/kalshi-universe.mjs` and `lib/ingestion/services/polymarket-universe.mjs`.

- These are the main orchestration loops
- At this point all their sub-dependencies will already be imported modules
- universe.mjs becomes a thin façade: loads env, wires services, calls `runUniverseIngest`

---

## Constraints

- `lib/pmci-ingestion.mjs` stays untouched throughout
- `runUniverseIngest` export signature must not change
- No behaviour changes at any slice — tests must pass before and after each commit
- No broad rewrite; each slice is a seam extraction with `import` wiring

---

## Current state after Slice 1

- `lib/ingestion/services/price-parsers.mjs` created (A + D)
- `lib/ingestion/universe.mjs` imports from it; definitions removed
- `test/ingestion/price-parsers.test.mjs` added
