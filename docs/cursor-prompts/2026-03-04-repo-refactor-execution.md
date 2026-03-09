# Cursor Prompt: Repo Refactor Execution — 7-Step Incremental Plan
> Generated: 2026-03-04
> Agents: @Codebase @Terminal

# Repo Refactor Execution Plan — 2026-03-04

## Context

Branch: `chore/infra-hardening-baseline-2026-02-26`
Based on: `docs/reports/2026-03-04-repository-audit-refactor-plan.md` (reviewed + corrected)
Decision log: infra-first, no execution/trading, preserve all wire formats.

## Guiding Constraints

- Preserve all behavior and wire formats (no semantic changes during refactor)
- Each step lands in its own PR; smoke tests must pass before merge
- Rollback = revert the PR; no step depends on a prior step being irreversible
- Do not touch: execution views, trading logic, `backtest-routing.mjs`

---

## Step 1 — Centralize env parsing

**Objective:** Eliminate duplicated `loadEnv()` implementations across the repo.

**Do NOT roll a custom parser.** Use `dotenv` (already a common Node.js dependency) or Node 20.6+ `--env-file` flag.

**Files to create:**
- `src/platform/env.mjs` — thin wrapper around dotenv that exports `loadEnv()`

**Files to migrate (replace local loadEnv with import):**
- `observer.mjs`
- `api.mjs`
- `src/db.mjs`
- `scripts/pmci-ingest-politics-universe.mjs`
- `scripts/pmci-propose-links-politics.mjs`
- `scripts/seed-pmci-families-links.mjs`
- Any other script with a local `loadEnv` or `fs.readFileSync('.env')` pattern

**Validation:**
```bash
npm run pmci:smoke
npm run pmci:probe
node src/api.mjs  # confirm API boots without error
```

**Rollback:** Revert `src/platform/env.mjs` and restore inline implementations.

---

## Step 2 — Introduce shared DB bootstrap helpers

**Objective:** Unify PG client/pool creation, close behavior, and retry strategy.

**Files to create:**
- `src/platform/db.mjs` — exports `createPool()` and `createClient()` with consistent config (SSL, max, idle timeout)

**Files to migrate:**
- `src/db.mjs` — use `createPool()` from platform
- `lib/pmci-ingestion.mjs` — use `createClient()` from platform
- High-traffic scripts that instantiate their own `pg.Client`

**Note:** `src/db.mjs` currently throws on missing `DATABASE_URL` at import time. Defer the throw to first use (i.e., lazy validation) so partial usage/testing is possible.

**Validation:**
```bash
npm run pmci:probe
curl http://localhost:8787/v1/health/slo
```

**Rollback:** Revert `src/platform/db.mjs`; restore inline client creation.

---

## Step 3 — Add test harness for runtime-critical paths (BEFORE API split)

**Objective:** Establish test coverage for the paths that Steps 4–5 will touch. Tests must exist before the medium-risk refactors.

**Files to create:**
- `test/routes/health.test.mjs` — Fastify inject tests for `/v1/health/*`
- `test/routes/coverage.test.mjs` — Fastify inject tests for `/v1/coverage*`
- `test/routes/signals.test.mjs` — Fastify inject tests for `/v1/signals/*`
- `test/ingestion/observer-cycle.test.mjs` — mocked provider payloads + mocked DB writer; assert counters

**Stack:** Node built-in test runner (`node:test`) + `node:assert`. No new test framework.

**Validation:**
```bash
node --test test/routes/*.test.mjs
node --test test/ingestion/*.test.mjs
```

**Rollback:** Delete test files (no production code changed in this step).

---

## Step 4 — Split PMCI API into route modules

**Objective:** Reduce `src/api.mjs` (~1000+ LOC) complexity while preserving all endpoints and middleware.

**File structure (flat, not deep):**
```
src/
  server.mjs           ← app bootstrap (replaces top-level boot in src/api.mjs)
  routes/
    health.mjs
    coverage.mjs
    markets.mjs
    families.mjs
    review.mjs
    signals.mjs
```

**Do NOT create** `src/server/hooks/`, `src/domain/providers/`, `src/data/queries/` — that depth is premature for current scale.

**Pattern:**
```js
// src/server.mjs
import Fastify from 'fastify';
import { registerHealthRoutes } from './routes/health.mjs';
// ...

export function buildApp(deps) {
  const app = Fastify({ logger: true });
  registerHealthRoutes(app, deps);
  // ...
  return app;
}
```

**Wire format requirement:** All URL paths, response shapes, and status codes must be identical to current `src/api.mjs`.

**Validation:** Run Step 3 test suite. All route contract tests must pass.

```bash
node --test test/routes/*.test.mjs
npm run pmci:smoke
```

**Rollback:** Revert route files; restore `src/api.mjs` as sole entrypoint.

---

## Step 5 — Extract observer/provider services

**Objective:** Make `observer.mjs` orchestration-only. Provider fetch/parse logic moves to `lib/`.

**Files to create (extend existing `lib/` — do not create new top-level dirs):**
- `lib/providers/kalshi.mjs` — Kalshi HTTP fetch + price normalization
- `lib/providers/polymarket.mjs` — Polymarket HTTP fetch + groupItemTitle parsing
- `lib/ingestion/observer-cycle.mjs` — one cycle: fetch → transform → write

**`observer.mjs` after refactor:** reads config, calls `runObserverCycle()` in a loop, logs summary counters. No HTTP or DB logic inline.

**Validation:**
```bash
node --test test/ingestion/observer-cycle.test.mjs
npm run start  # run 1 cycle, confirm "PMCI ingestion enabled" + zero errors
npm run pmci:probe  # confirm snapshot count grew
```

**Rollback:** Revert `lib/providers/`, `lib/ingestion/`; restore inline observer logic.

---

## Step 6 — Thin CLI wrappers for heavy scripts

**Objective:** Move core logic out of monolithic scripts into `lib/` modules; keep scripts as CLI entry points only.

**Targets:**
- `scripts/pmci-propose-links-politics.mjs` → extract proposal scoring to `lib/matching/proposal-engine.mjs`
- `scripts/pmci-ingest-politics-universe.mjs` → extract universe fetch/ingest to `lib/ingestion/universe.mjs`

**Script pattern after refactor:**
```js
// scripts/pmci-propose-links-politics.mjs
import { loadEnv } from '../src/platform/env.mjs';
import { runProposalEngine } from '../lib/matching/proposal-engine.mjs';
loadEnv();
const result = await runProposalEngine({ dryRun: process.argv.includes('--dry-run') });
console.log(result.summary);
process.exit(result.ok ? 0 : 1);
```

**Validation:**
```bash
npm run pmci:propose:politics -- --dry-run  # must exit 0 with proposal summary
npm run pmci:ingest:politics:universe       # must produce same row counts as baseline
```

**Rollback:** Revert `lib/matching/`, `lib/ingestion/universe.mjs`; restore script inline logic.

---

## Step 7 — Clarify legacy vs active runtime surfaces

**Objective:** Document deprecation boundary for `api.mjs` (legacy Node HTTP server).

**Changes:**
- Add deprecation header comment to `api.mjs` noting it is superseded by `src/api.mjs` (Fastify PMCI API)
- Update `docs/system-state.md` with explicit "legacy surface" note
- Append to `docs/decision-log.md`: decision to deprecate `api.mjs` in favor of `src/api.mjs`
- Do NOT delete `api.mjs` yet — document sunset milestone only

**Validation:** Both servers still boot. No behavior change.

---

## Shared Utilities to Introduce (any step, opportunistically)

### `parseProbability` — centralized price/probability parsing
```js
// lib/parse-probability.mjs
export function parseProbability(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}
```
Replace divergent `parseNum`, range checks, and null guards across observer + ingestion scripts.

---

## Dependency Map (RELATIONSHIP_MANAGER guardrails)

```
src/platform/env.mjs    ← consumed by: all scripts, observer, api surfaces
src/platform/db.mjs     ← consumed by: src/db.mjs, lib/pmci-ingestion.mjs, scripts
lib/providers/*         ← consumed by: lib/ingestion/observer-cycle.mjs
lib/ingestion/*         ← consumed by: observer.mjs (thin orchestrator)
lib/matching/*          ← consumed by: scripts/pmci-propose-links-politics.mjs
src/routes/*            ← consumed by: src/server.mjs
```

**Guardrails:**
- `src/platform/` must have zero imports from `lib/` or `scripts/` (no circular risk)
- `lib/` modules must have zero imports from `src/` (lib is lower-level than src)
- Scripts import from both `src/platform/` and `lib/` — that is expected and correct
- No step may change SQL query shapes in `src/queries.mjs` without updating route tests

---

## Step Sequence Summary

| Step | Risk | PR size | Prerequisite |
|------|------|---------|--------------|
| 1 — env centralization | Low | Small | None |
| 2 — DB bootstrap helpers | Low-Medium | Small | Step 1 |
| 3 — Test harness | Low | Medium | Step 2 |
| 4 — API route split | Medium | Medium | Step 3 |
| 5 — Observer extraction | Medium | Medium | Step 3 |
| 6 — Script thin wrappers | Medium | Medium | Step 5 |
| 7 — Legacy deprecation docs | Low | Tiny | Step 4 |

---

## Pre-flight Checks (run before starting)

```bash
npm run pmci:probe       # baseline row counts
npm run pmci:smoke       # must pass
npm run verify:schema    # must pass
```

Record baseline counts. After each step, re-run and confirm counts are stable.
