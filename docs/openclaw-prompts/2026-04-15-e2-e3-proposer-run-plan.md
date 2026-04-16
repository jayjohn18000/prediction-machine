# Cursor Execution Prompt: E2 Crypto + E3 Economics Guard-First Proposer Runs
> Generated: 2026-04-15
> Working directory: ~/prediction-machine
> Branch: main

## PMCI Invariants
- No .env writes — print proposed changes only
- Run `npm run verify:schema` after any migration
- New routes in `src/api.mjs` only, never root `api.mjs`
- Inactive-guard check before any bulk market changes
- All new categories use guard-first proposer + strict-audit gate loop
- Active markets only; no historical/settled market ingestion

## Situation Summary
E2 (crypto) and E3 (economics) scaffolds are committed to main as of 2026-04-15 (commit `8db2b41`). The guard-first proposer scripts exist at `scripts/review/pmci-propose-links-crypto.mjs` and `scripts/review/pmci-propose-links-economics.mjs` but have NOT been run yet — zero crypto/economics proposals in the DB. This plan runs both proposers in dry-run first, then live, and audits the results.

## Tracks (run A and B in parallel)

### Track A — E2 Crypto proposer (critical path)

**A1: Ingest crypto markets first**
Run: `npm run pmci:ingest:crypto`
Hard gate: exits 0, prints market counts for both kalshi + polymarket crypto

**A2: Dry-run the crypto proposer**
Run: `node scripts/review/pmci-propose-links-crypto.mjs --dry-run --verbose`
Hard gate: exits 0, prints `considered`, `would_insert`, `rejected` counts. No DB writes.

**A3: Live proposer run (if dry-run looks sane — i.e. would_insert > 0 and < 500)**
Run: `npm run pmci:propose:crypto`
Hard gate: exits 0, prints inserted count > 0

**A4: Check pending proposals**
Run: `node scripts/review/pmci-check-proposals.mjs --category crypto`
Hard gate: prints pending count > 0

### Track B — E3 Economics proposer (parallel with A)

**B1: Ingest economics markets first**
Run: `npm run pmci:ingest:economics`
Hard gate: exits 0, prints market counts for both providers

**B2: Dry-run the economics proposer**
Run: `node scripts/review/pmci-propose-links-economics.mjs --dry-run --verbose`
Hard gate: exits 0, prints `considered`, `would_insert`, `rejected` counts

**B3: Live proposer run (if dry-run looks sane)**
Run: `npm run pmci:propose:economics`
Hard gate: exits 0, prints inserted count > 0

**B4: Check pending proposals**
Run: `node scripts/review/pmci-check-proposals.mjs --category economics`
Hard gate: prints pending count > 0

## Verification sequence (run after both tracks complete)
```bash
npm run pmci:smoke
npm run verify:schema
node scripts/review/pmci-check-proposals.mjs
```
Return the full output of all three commands.

## Reference files (read these for context before executing)
- ~/prediction-machine/docs/system-state.md
- ~/prediction-machine/docs/roadmap.md
- ~/prediction-machine/scripts/review/pmci-propose-links-crypto.mjs
- ~/prediction-machine/scripts/review/pmci-propose-links-economics.mjs
- ~/prediction-machine/lib/ingestion/crypto-universe.mjs
- ~/prediction-machine/lib/ingestion/economics-universe.mjs
