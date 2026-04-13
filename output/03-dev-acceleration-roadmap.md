# Development Acceleration Roadmap

**Generated:** 2026-04-13  
**Repo:** `prediction-machine` — PMCI backend intelligence engine  
**Current phase:** E1 stabilization + E2 crypto planning

---

## 1. Executive Summary

Prediction Machine has solid infrastructure (Phases A–D complete) and a working politics normalization pipeline, but is bottlenecked on sports ingestion stabilization and has no path to new categories without significant per-category engineering. The proposal engine (`lib/matching/proposal-engine.mjs`, 1,234 lines) is politics-hardcoded, the ingestion layer duplicates logic across `universe.mjs` and `sports-universe.mjs`, and there is no plugin architecture for adding crypto/weather/economics. The highest-leverage investments are: (1) extracting a category-agnostic ingestion+matching framework, (2) stabilizing sports strict-audit metrics, and (3) building the execution-readiness layer (Phase F) to start generating revenue. Development happens through AI agent sessions, so establishing clear module boundaries, fixture-driven contracts, and self-contained work packets is critical for velocity.

---

## 2. Current Architecture Assessment

### What Works Well

- **PMCI schema and data model**: `pmci.provider_markets`, `provider_market_snapshots`, `market_families`, `market_links`, `proposed_links` — clean, well-migrated schema (23 migrations). The `v_market_links_current` view abstracts link resolution nicely.
- **Provider adapters**: `lib/providers/kalshi.mjs` and `lib/providers/polymarket.mjs` are clean, focused HTTP clients with retry logic, sticky base URLs, and price normalization. The adapter layer (`kalshi-adapter.mjs`, `polymarket-adapter.mjs`) maps raw payloads to `CanonicalEvent` shapes.
- **Canonical event schema**: `lib/events-schema.mjs` defines provider-agnostic `CanonicalEvent`, `CanonicalMarket`, `CanonicalOutcome` types with JSDoc. This is the right foundation for multi-category expansion.
- **API surface**: `src/server.mjs` + route modules (`health`, `coverage`, `markets`, `families`, `signals`, `review`, `links`) are well-organized with dependency injection, freshness assertions, CORS, rate limiting, and auth.
- **Test infrastructure**: 28 test files under `test/` using `node:test` with golden fixture regression tests for matching. Fixtures in `test/fixtures/matching/` provide deterministic validation.
- **Operational tooling**: Strong operational script library (50+ scripts) for smoke testing, schema verification, auditing, discovery, and review.
- **Documentation discipline**: `docs/roadmap.md`, `docs/system-state.md`, `docs/decision-log.md` form a living audit trail. Agent role definitions in `agents/` (27 agent specs).

### What Doesn't Work / Where the Friction Is

1. **Proposal engine is politics-monolith**: `lib/matching/proposal-engine.mjs` (1,234 lines) is hardcoded to `CATEGORY = 'politics'`. It contains US state codes, election phase classification, governor/senate/house topic patterns, and political entity parsing interleaved with the generic matching algorithm. Adding sports or crypto matching requires forking this file or a major refactor.

2. **Ingestion is copy-paste per category**: `lib/ingestion/universe.mjs` (881 lines, politics) and `lib/ingestion/sports-universe.mjs` (523 lines) share the same structure (fetch series → iterate events → iterate markets → upsert + snapshot) but duplicate all the boilerplate. Adding crypto means writing a third 500+ line file.

3. **No provider adapter interface**: Kalshi and Polymarket fetch logic is duplicated inside each `*-universe.mjs` file with inline `fetchJson`/`fetchKalshiWithRetry` functions. The actual provider adapters (`kalshi-adapter.mjs`, `polymarket-adapter.mjs`) are only used for `CanonicalEvent` mapping, not for ingestion.

4. **Sports strict-audit is red**: As of 2026-04-13: `stale_active=8,317`, `unknown_sport=1,663`, `semantic_violations=369`. This blocks E2 promotion and means the sports proposer generates noise.

5. **No test runner configured in package.json**: There is no `test` script in `package.json`. Tests use `node:test` but must be run manually. No CI pipeline exists (no `.github/workflows/`).

6. **Observer is politics-only by config**: `observer.mjs` reads from `scripts/prediction_market_event_pairs.json` which is a static list of Kalshi↔Polymarket political candidate pairs. Sports ingestion runs on a separate 4-hour cron (`lib/ingestion/sports-universe.mjs`). There is no unified observer that handles multiple categories.

7. **No execution layer code exists**: Phase F routes (`/v1/signals/ranked`, `/v1/router/best-venue`), services (`tradability-service.mjs`, `router-service.mjs`), and config (`execution-readiness.json`) are all absent. The gap between "intelligence substrate" and "making money" is entirely unbuilt.

8. **Session context overhead**: Each AI agent session must re-read `CLAUDE.md`, `docs/architecture.md`, `docs/system-state.md`, `docs/db-schema-reference.md` to orient. There are no per-module README files, no interface contracts beyond JSDoc, and the `DEV_WORKFLOW.md` is minimal.

---

## 3. 30/60/90-Day Roadmap

### Days 1–30: Unblock Sports, Establish Foundation

| Week | Deliverable | Dependencies | Exit Criteria |
|------|------------|-------------|---------------|
| 1 | **Sports strict-audit green** | None | `stale_active < 100`, `unknown_sport < 500`, `semantic_violations = 0` |
| 1 | **Add `npm test` to package.json** | None | `node --test test/**/*.test.mjs` passes, script added |
| 2 | **Extract `SourceAdapter` interface** | None | `lib/adapters/kalshi-source.mjs`, `lib/adapters/polymarket-source.mjs` implementing `fetchCategories()`, `fetchMarkets(category)`, `parsePrice(raw)` |
| 2 | **Extract `CategoryIngester` base** | SourceAdapter | `lib/ingestion/category-ingester.mjs` with shared fetch→upsert→snapshot loop; `universe.mjs` and `sports-universe.mjs` refactored to extend it |
| 3 | **Sports proposer** | Sports audit green | `scripts/review/pmci-propose-links-sports.mjs` using generic matching with sports-specific guards (from `sports-helpers.mjs`) |
| 3 | **Expand accepted sports pairs** | Sports proposer | NBA, NHL, NFL cross-platform links accepted beyond soccer |
| 4 | **CI pipeline** | `npm test` | GitHub Actions: lint check, `npm test`, `npm run verify:schema` on PR |
| 4 | **Fixture-driven ingestion tests** | SourceAdapter | Captured Kalshi/Polymarket JSON responses as fixtures; adapter tests validate parsing without network calls |

**Key files to change:**
- `lib/ingestion/sports-universe.mjs` — stale cleanup, unknown sport backfill
- `scripts/stale-cleanup.mjs` — re-run for 8,317 stale active sports markets
- `scripts/backfill-sport-inference.mjs` — re-run for 1,663 unknown sport markets
- `lib/ingestion/services/sport-inference.mjs` — add missing patterns
- `package.json` — add `"test": "node --test test/**/*.test.mjs"`

### Days 31–60: Multi-Category + Execution MVP

| Week | Deliverable | Dependencies | Exit Criteria |
|------|------------|-------------|---------------|
| 5 | **Crypto ingestion** (`lib/ingestion/crypto-universe.mjs`) | CategoryIngester base | BTC/ETH price-target markets from Kalshi + Polymarket ingested; `npm run pmci:ingest:crypto` works |
| 5 | **Generic proposal engine** | CategoryIngester | Extract category-agnostic core from `proposal-engine.mjs`; politics/sports/crypto each provide a `MatchingProfile` with guards, blocking keys, and scoring weights |
| 6 | **Crypto proposer + audit** | Crypto ingestion | Cross-platform crypto links proposed and accepted via guard-first gate loop |
| 6 | **Phase F1: Tradability model** | Multi-category links | `src/services/tradability-service.mjs` with `relationship_type`, `freshness_eligible`, `fee_estimate`, `net_edge` per family |
| 7 | **Phase F2: Execution metrics** | Tradability model | `fee_adjusted_edge`, `slippage_adjusted_edge`, `edge_half_life`, `consensus_price` computed and stored |
| 7 | **Phase F3: Ranked signals API** | Execution metrics | `GET /v1/signals/ranked` returns families ranked by net executable edge |
| 8 | **Monitoring dashboard** | API surface | `lovable-ui` page consuming `/v1/signals/ranked` + `/v1/health/slo` for live operational view |

**Key files to create:**
- `lib/ingestion/crypto-universe.mjs`
- `lib/matching/matching-profile.mjs` — category-specific matching configuration
- `lib/matching/generic-proposal-engine.mjs` — category-agnostic proposal core
- `src/services/tradability-service.mjs`
- `src/services/router-service.mjs`
- `src/routes/execution.mjs`
- `config/execution-readiness.json`

### Days 61–90: Full Coverage + Automated Execution

| Week | Deliverable | Dependencies | Exit Criteria |
|------|------------|-------------|---------------|
| 9 | **Economics/macro ingestion** | CategoryIngester | Fed rate, GDP, inflation markets from Kalshi + Polymarket |
| 9 | **Weather ingestion** | CategoryIngester | Temperature, hurricane markets if available |
| 10 | **Phase G: Paper trader** | Ranked signals API | Shadow execution consuming PMCI signals, tracking synthetic PnL |
| 10 | **Unified observer** | Multi-category ingestion | Single `observer.mjs` that runs all category ingesters on configurable intervals |
| 11 | **Automated sports lifecycle** | Sports proposer | Auto-archive settled game markets via `resolves_at` + pg_cron |
| 11 | **Alerting** | Paper trader | Slack/email alerts for stale data, proposer drift, execution opportunities |
| 12 | **Phase H preparation** | Paper trader profitable | Venue-specific order adapters for Kalshi + Polymarket; kill switches and exposure caps documented |

---

## 4. Suggested Module Architecture

### Recommended File Structure

```
lib/
├── adapters/                          # Provider source adapters (NEW)
│   ├── base-source-adapter.mjs        # Abstract: fetchSeries, fetchEvents, fetchMarkets, parsePrice
│   ├── kalshi-source.mjs              # Kalshi implementation
│   └── polymarket-source.mjs          # Polymarket implementation
├── ingestion/
│   ├── category-ingester.mjs          # Shared fetch→upsert→snapshot loop (NEW, extracted)
│   ├── politics-ingester.mjs          # Politics-specific config (refactored from universe.mjs)
│   ├── sports-ingester.mjs            # Sports-specific config (refactored from sports-universe.mjs)
│   ├── crypto-ingester.mjs            # Crypto-specific config (NEW)
│   ├── observer-cycle.mjs             # Existing, enhanced to call all category ingesters
│   ├── pmci-sweep.mjs                 # Existing
│   └── services/
│       ├── price-parsers.mjs          # Existing
│       ├── market-metadata.mjs        # Existing
│       └── sport-inference.mjs        # Existing
├── matching/
│   ├── matching-profile.mjs           # Category-specific scoring config (NEW)
│   ├── generic-proposal-engine.mjs    # Category-agnostic proposal core (NEW, extracted)
│   ├── proposal-engine.mjs            # Existing (deprecated → delegates to generic)
│   ├── scoring.mjs                    # Existing, unchanged
│   ├── entity-parse.mjs              # Existing, unchanged
│   ├── sports-helpers.mjs             # Existing, unchanged
│   └── profiles/                      # Per-category matching profiles (NEW)
│       ├── politics-profile.mjs
│       ├── sports-profile.mjs
│       └── crypto-profile.mjs
├── providers/                         # Existing price-fetch clients
│   ├── kalshi.mjs
│   ├── polymarket.mjs
│   ├── kalshi-adapter.mjs            # CanonicalEvent mapping
│   └── polymarket-adapter.mjs        # CanonicalEvent mapping
├── execution/                         # Execution layer (NEW — Phase F+)
│   ├── tradability.mjs               # Tradability scoring per family
│   ├── net-edge.mjs                  # Fee/slippage-adjusted edge computation
│   └── router.mjs                    # Best-venue routing
├── guards/
│   └── inactive-guard.mjs            # Existing
├── events-schema.mjs                 # Existing
├── pmci-client.mjs                   # Existing
├── pmci-ingestion.mjs                # Existing
├── pmci-matching-adapters.mjs        # Existing
├── retry.mjs                         # Existing
├── embeddings.mjs                    # Existing
└── types.ts                          # Existing

src/
├── api.mjs                           # Existing entrypoint
├── server.mjs                        # Existing bootstrap
├── db.mjs                            # Existing
├── queries.mjs                       # Existing
├── platform/                         # Existing
├── repositories/                     # Existing
├── routes/
│   ├── health.mjs                    # Existing
│   ├── coverage.mjs                  # Existing
│   ├── markets.mjs                   # Existing
│   ├── families.mjs                  # Existing
│   ├── signals.mjs                   # Existing
│   ├── review.mjs                    # Existing
│   ├── links.mjs                     # Existing
│   └── execution.mjs                 # NEW — Phase F endpoints
├── services/
│   ├── signal-queries.mjs            # Existing
│   ├── review-service.mjs            # Existing
│   ├── coverage-service.mjs          # Existing
│   ├── markets-service.mjs           # Existing
│   ├── observer-health.mjs           # Existing
│   ├── runtime-status.mjs            # Existing
│   ├── request-log-buffer.mjs        # Existing
│   ├── tradability-service.mjs       # NEW — Phase F1
│   └── router-service.mjs            # NEW — Phase F3
└── utils/                            # Existing

test/
├── fixtures/
│   ├── matching/                     # Existing golden fixtures
│   ├── ingestion/                    # NEW — captured provider JSON responses
│   │   ├── kalshi-sports-series.fixture.json
│   │   ├── kalshi-markets-response.fixture.json
│   │   ├── polymarket-sports-tags.fixture.json
│   │   └── polymarket-markets-response.fixture.json
│   └── execution/                    # NEW — tradability/edge test data
│       └── tradability-cases.fixture.json
├── adapters/                         # NEW — source adapter unit tests
│   ├── kalshi-source.test.mjs
│   └── polymarket-source.test.mjs
├── matching/                         # Existing
├── ingestion/                        # Existing
├── routes/                           # Existing
├── services/                         # Existing
└── execution/                        # NEW
    └── tradability.test.mjs
```

### Key Architectural Principles

1. **Source Adapter Pattern**: Each provider implements `BaseSourceAdapter` with methods like `fetchSeries(category)`, `fetchEventsForSeries(seriesTicker)`, `fetchMarketsForEvent(eventTicker)`, and `normalizeMarket(raw) → NormalizedMarket`. This eliminates the duplicated fetch/retry/parse logic across `universe.mjs` and `sports-universe.mjs`.

2. **Category Ingester Pattern**: `CategoryIngester` is a shared orchestration class that takes a `SourceAdapter[]` and a `CategoryConfig` (with filters, inference functions, and metadata enrichment). Each category provides only its configuration; the fetch→upsert→snapshot loop is shared.

3. **Matching Profile Pattern**: Each category provides a `MatchingProfile` that specifies: blocking key extraction, semantic guards, scoring weight overrides, minimum confidence thresholds, and auto-accept criteria. The generic proposal engine consumes these profiles without category-specific branching.

---

## 5. Agent-Based Development Practices

### Making Cursor/Agent Sessions More Productive

**Problem**: Each session currently requires reading 5+ docs to orient. The proposal engine is a 1,234-line monolith that is hard to reason about in context windows.

**Solutions:**

1. **Per-module CONTEXT.md files**: Add a 10–20 line `CONTEXT.md` in each `lib/` subdirectory explaining what the module does, its inputs and outputs, key functions and contracts, and what not to touch. Example for `lib/matching/CONTEXT.md`:

   ```
   # Matching Module
   Generates cross-platform link proposals by comparing unlinked provider_markets.

   ## Key functions
   - proposal-engine.mjs: runProposalEngine({ dryRun }) — main entry
   - scoring.mjs: scorePair(), jaccard(), cosineSimilarity() — pure math
   - entity-parse.mjs: parsePolyRef(), parseKalshiTitle() — entity extraction
   - sports-helpers.mjs: sportsEntityFromMarket(), isSportsPairSemanticallyValid()

   ## Contracts
   - Input: reads pmci.provider_markets, pmci.proposed_links, pmci.market_links
   - Output: writes pmci.proposed_links, pmci.market_links, pmci.market_families
   - scoring.mjs is PURE — no DB, no side effects

   ## Do not modify without also updating
   - scoring.mjs formula weights → test/fixtures/matching/proposal-shape.fixture.json
   - Golden fixture schema versions
   ```

2. **Typed interface files**: Populate `lib/types.ts` with interfaces for all cross-module boundaries. Even though the runtime is .mjs, TypeScript interfaces serve as documentation that agents can reference.

3. **Work packet format**: Structure agent tasks as:
   ```
   ## Task: [name]
   ### Files to read first: [list]
   ### Files to modify: [list]
   ### Files NOT to modify: [list]
   ### Verification: [commands to run]
   ### Success criteria: [specific, measurable]
   ```

4. **Fixture-first development**: For any new matching logic, write the fixture first (`test/fixtures/matching/*.fixture.json`), then implement the code. This gives agents a concrete target and prevents regression.

### Documentation and Context Files to Maintain

| File | Purpose | Update trigger |
|------|---------|---------------|
| `CLAUDE.md` | Session orientation | Any new entrypoint, command, or invariant |
| `docs/system-state.md` | Live runtime truth | After any `pmci:smoke` / `pmci:audit` |
| `docs/roadmap.md` | Phase tracking | After any phase milestone |
| `docs/decision-log.md` | Architecture rationale | After any non-trivial decision |
| `docs/db-schema-reference.md` | Column reference | After any migration |
| `lib/*/CONTEXT.md` | Per-module orientation (NEW) | After any module API change |
| `docs/contracts.md` | Data object shapes | After any contract change |

### Structuring Work for Parallel Agents

The following subsystems can be worked on in parallel by separate agent sessions without conflict:

| Workstream | Files | Can parallelize with |
|-----------|-------|---------------------|
| Sports stabilization | `lib/ingestion/sports-universe.mjs`, `lib/ingestion/services/sport-inference.mjs`, `scripts/stale-cleanup.mjs`, `scripts/backfill-sport-inference.mjs` | Everything except sports proposer |
| Source adapter extraction | `lib/adapters/` (new), `lib/ingestion/category-ingester.mjs` (new) | Everything except ingestion refactors |
| Crypto ingestion | `lib/ingestion/crypto-universe.mjs` (new) | Everything except adapter extraction |
| Execution layer | `src/services/tradability-service.mjs` (new), `src/routes/execution.mjs` (new), `lib/execution/` (new) | Everything |
| Test infrastructure | `test/`, `package.json`, `.github/workflows/` | Everything |
| Matching generalization | `lib/matching/generic-proposal-engine.mjs` (new), `lib/matching/profiles/` (new) | Everything except proposal-engine.mjs edits |

### AGENTS.md / CLAUDE.md Improvements

**CLAUDE.md should add a Session Quick-Start Checklist:**
1. Read this file
2. Read `docs/system-state.md` (current runtime state)
3. Read the `CONTEXT.md` in the module you are working on
4. Run `npm run verify:schema` to confirm DB state
5. Run `npm test` before and after changes

**CLAUDE.md should add Module Boundaries:**
- `lib/adapters/` — provider HTTP fetch (no DB)
- `lib/ingestion/` — category-specific ingestion orchestration (DB writes)
- `lib/matching/` — proposal generation and scoring (DB reads + writes)
- `lib/providers/` — raw price fetch for observer (no DB writes)
- `src/routes/` — API endpoints (read-only from DB)
- `src/services/` — business logic behind routes
- `lib/execution/` — tradability, edge, routing (NEW)

**AGENTS.md should add Parallel Agent Safety:**
- Only ONE agent should modify files in `lib/matching/` at a time
- Only ONE agent should modify files in `lib/ingestion/` at a time
- Multiple agents CAN work on different route files simultaneously
- Multiple agents CAN work on different test files simultaneously
- Never modify `supabase/migrations/` without operator approval

---

## 6. Prioritized Engineering Investments

Ranked by impact/effort ratio (highest first):

| # | Investment | Impact | Effort | Rationale |
|---|-----------|--------|--------|-----------|
| 1 | **Add `npm test` script + CI** | Very High | Low | 1 line in package.json + 1 GitHub Actions file. Prevents regressions that currently require manual detection. |
| 2 | **Sports stale cleanup + backfill rerun** | Very High | Low | Run existing scripts. Unblocks E2 promotion and sports proposer. |
| 3 | **Extract CategoryIngester base class** | Very High | Medium | Eliminates ~400 lines of duplication and makes adding crypto/economics a config task instead of a coding task. |
| 4 | **Per-module CONTEXT.md files** | High | Low | 30 minutes of writing. Saves 15+ minutes per agent session in orientation time. |
| 5 | **Source adapter interface** | High | Medium | Clean separation of HTTP fetch from business logic. Enables fixture-driven testing without network calls. |
| 6 | **Generic proposal engine extraction** | High | High | Unlocks multi-category matching without forking the 1,234-line monolith. Biggest single refactor. |
| 7 | **Crypto ingestion** | High | Medium | New market category = new cross-platform signal surface. Uses adapter pattern if built. |
| 8 | **Phase F1: Tradability model** | Very High | Medium | Directly enables revenue path. Answers "is this edge actually tradeable after fees?" |
| 9 | **Ingestion fixtures** | Medium | Low | Capture 5–10 provider JSON responses. Makes ingestion tests deterministic and network-free. |
| 10 | **Unified observer** | Medium | Medium | Replace `observer.mjs` (politics-only) + cron (sports) with a single multi-category observer. Reduces operational complexity. |
| 11 | **Phase F3: Ranked signals API** | Very High | Medium | Revenue surface: machine-consumable ranked opportunities. Prerequisite for paper trading. |
| 12 | **Monitoring/alerting** | Medium | Medium | Slack alerts for stale data, proposer drift, API errors. Currently manual `npm run pmci:smoke`. |

---

## 7. "Next 5 Commits" Plan

### Commit 1: Add test runner and CI basics
**Files:**
- `package.json` — add `"test": "node --test test/**/*.test.mjs"`
- `.github/workflows/ci.yml` — create with: checkout, install, `npm test`, `npm run verify:schema`

**Verification:** `npm test` passes locally.

### Commit 2: Sports strict-audit stabilization
**Files:**
- Run `scripts/stale-cleanup.mjs` — clear 8,317 stale active sports markets
- Run `scripts/backfill-sport-inference.mjs` — reduce 1,663 unknown sport markets
- `lib/ingestion/services/sport-inference.mjs` — add any missing patterns for remaining unknowns

**Verification:**
```bash
npm run pmci:audit:sports:packet
# Target: stale_active < 100, unknown_sport < 500, semantic_violations = 0
```

### Commit 3: Per-module CONTEXT.md files
**Files (new):**
- `lib/matching/CONTEXT.md`
- `lib/ingestion/CONTEXT.md`
- `lib/providers/CONTEXT.md`
- `src/routes/CONTEXT.md`
- `src/services/CONTEXT.md`

**Verification:** Each file exists and contains module purpose, key functions, contracts, and do-not-touch notes.

### Commit 4: Source adapter interface + Kalshi implementation
**Files (new):**
- `lib/adapters/base-source-adapter.mjs` — abstract class with `fetchSeries()`, `fetchEventsForSeries()`, `fetchMarketsForEvent()`, `normalizeMarket()`
- `lib/adapters/kalshi-source.mjs` — implements base for Kalshi
- `test/adapters/kalshi-source.test.mjs` — tests with captured fixtures
- `test/fixtures/ingestion/kalshi-series-response.fixture.json`

**Verification:** `node --test test/adapters/kalshi-source.test.mjs` passes.

### Commit 5: Extract CategoryIngester base
**Files (new):**
- `lib/ingestion/category-ingester.mjs` — shared fetch→upsert→snapshot orchestration

**Files (modified):**
- `lib/ingestion/sports-universe.mjs` — refactor to use `CategoryIngester`
- `test/ingestion/category-ingester.test.mjs` — unit tests

**Verification:**
```bash
npm test
npm run pmci:ingest:sports  # Still works after refactor
npm run pmci:smoke          # Counts unchanged or increased
```

---

## 8. Testing Strategy

### Current Test Coverage Assessment

| Area | Files | Status | Gap |
|------|-------|--------|-----|
| Matching scoring | `test/matching/scoring.test.mjs` | Good | Covers tokenize, jaccard, cosine, scorePair, bipartite |
| Golden fixtures | `test/matching/golden-fixtures.test.mjs` | Good | 4 fixture files with regression harness |
| Topic signatures | `test/matching/topic-sig.test.mjs`, `topic-normalize.test.mjs`, `tx33.test.mjs` | Good | Specific election pattern coverage |
| Price parsers | `test/ingestion/price-parsers.test.mjs` | Good | Covers parseNum, clamp01, parseOutcomes |
| Market metadata | `test/ingestion/market-metadata.test.mjs` | Good | Election phase/subject type inference |
| Observer cycle | `test/ingestion/observer-cycle.test.mjs` | Partial | Needs DB mocking or fixture-based tests |
| Config schema | `test/platform/config-schema.test.mjs` | Good | Zod validation |
| Route tests | `test/routes/health.test.mjs`, `coverage.test.mjs`, `signals.test.mjs`, `review.test.mjs` | Present | May need DB mocking updates |
| Adapters | `test/kalshi-adapter.test.mjs`, `test/polymarket-adapter.test.mjs` | Present | CanonicalEvent mapping |
| **Provider fetch** | **None** | **Missing** | **No tests for kalshi.mjs or polymarket.mjs HTTP fetch** |
| **Sports inference** | **None** | **Missing** | **No unit tests for sport-inference.mjs (170+ regex patterns)** |
| **Sports helpers** | **None** | **Missing** | **No unit tests for sports-helpers.mjs** |
| **Ingestion pipeline** | **None** | **Missing** | **No tests for universe.mjs or sports-universe.mjs** |
| **Execution layer** | **None** | **Missing** | **Does not exist yet** |

### Recommended Fixtures

1. **Provider response fixtures** (highest leverage):
   - `test/fixtures/ingestion/kalshi-series-list.fixture.json` — subset of `/series?limit=100` response
   - `test/fixtures/ingestion/kalshi-events-sports.fixture.json` — sports events for a series
   - `test/fixtures/ingestion/kalshi-markets-response.fixture.json` — markets for an event
   - `test/fixtures/ingestion/polymarket-sports-tags.fixture.json` — `/sports` endpoint response
   - `test/fixtures/ingestion/polymarket-markets-by-tag.fixture.json` — `/markets?tag_id=X` response

2. **Sport inference fixtures**:
   - `test/fixtures/ingestion/sport-inference-cases.fixture.json` — `[{ input: "Pro football exact wins SF", expected: "nfl" }, ...]`

3. **Sports matching fixtures**:
   - `test/fixtures/matching/sports-entity-cases.fixture.json` — `sportsEntityFromMarket()` test cases
   - `test/fixtures/matching/sports-pair-validity.fixture.json` — `isSportsPairSemanticallyValid()` cases

4. **Execution fixtures** (Phase F):
   - `test/fixtures/execution/tradability-cases.fixture.json` — family data → tradability score
   - `test/fixtures/execution/net-edge-cases.fixture.json` — gross edge + fees → net edge

### Testing Recommendations

1. **Priority 1**: Add sport inference tests. The `KALSHI_TICKER_MAP` and `KALSHI_SERIES_TICKER_FALLBACK` arrays in `sport-inference.mjs` have 170+ patterns. A fixture with 50+ cases would catch regex regressions instantly.

2. **Priority 2**: Add provider fetch tests with nock/fixture mocking. Currently, all ingestion testing requires live API calls.

3. **Priority 3**: Add integration smoke tests that run the proposal engine in dry-run mode against fixture data. This validates the full pipeline without DB writes.

4. **Node test runner config**: Add to `package.json`:
   ```json
   "test": "node --test test/**/*.test.mjs",
   "test:matching": "node --test test/matching/",
   "test:ingestion": "node --test test/ingestion/",
   "test:routes": "node --test test/routes/"
   ```

---

## 9. Missing Infrastructure

### CI/CD (Critical — completely absent)

- **No `.github/workflows/`** — zero automated testing on push/PR
- **Recommended pipeline:**
  ```yaml
  name: CI
  on: [push, pull_request]
  jobs:
    test:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: '22'
        - run: npm ci
        - run: npm test
  ```

### Monitoring (Partial — manual scripts only)

- **What exists:** `scripts/checks/pmci-watch.mjs`, `scripts/ops/pmci-observer-watchdog.sh`, `scripts/ops/pmci-api-health.sh` — manual health checks
- **What is missing:**
  - No process manager (PM2, systemd, or Docker)
  - No alerting (Slack, PagerDuty, email)
  - No metrics collection (Prometheus, Datadog)
  - No log aggregation
  - `observer.mjs` and `src/api.mjs` have no crash recovery beyond SIGINT/SIGTERM handlers

- **Recommended additions:**
  1. PM2 ecosystem file for observer + API with restart-on-crash
  2. `scripts/ops/pmci-alert.mjs` — check freshness + smoke metrics, send Slack webhook on failure
  3. Health check cron: `*/5 * * * * node scripts/ops/pmci-alert.mjs`

### Schema Validation (Good — exists but not automated)

- `npm run verify:schema` exists and works
- Missing from CI pipeline
- Missing: automated post-migration validation
- Recommended: add `verify:schema` as a post-`db:push` hook

### Environment/Configuration Management

- `.env.example` exists (good)
- `src/platform/config-schema.mjs` uses Zod for API config (good)
- Missing: Zod validation for ingestion env vars (`PMCI_POLITICS_KALSHI_SERIES_TICKERS`, `PMCI_POLITICS_POLY_TAG_ID`, etc.)
- Missing: runtime config validation on observer startup

### Deployment

- `Caddyfile` exists for reverse proxy (good)
- No Docker configuration
- No deployment automation
- Recommended: `Dockerfile` for both observer and API, `docker-compose.yml` for local dev

### Data Quality

- Snapshot retention exists (pg_cron, 30 days) — good
- No data quality alerts for:
  - Price staleness per provider
  - Snapshot gap detection (>2x expected interval)
  - Market count anomalies (sudden drops)
  - Proposal quality drift (acceptance rate tracking)

---

## Appendix: Key Function Reference

| Function | File | Purpose |
|----------|------|---------|
| `runObserverCycle()` | `lib/ingestion/observer-cycle.mjs` | Main observer loop iteration |
| `runSportsUniverse()` | `lib/ingestion/sports-universe.mjs` | Sports ingestion entry point |
| `runUniverseIngest()` | `lib/ingestion/universe.mjs` | Politics ingestion entry point |
| `runProposalEngine()` | `lib/matching/proposal-engine.mjs` | Politics proposal generation |
| `scorePair()` | `lib/matching/scoring.mjs` | Pure scoring math |
| `inferSportFromKalshiTicker()` | `lib/ingestion/services/sport-inference.mjs` | Sport code inference |
| `isSportsPairSemanticallyValid()` | `lib/matching/sports-helpers.mjs` | Sports pair validation |
| `ingestProviderMarket()` | `lib/pmci-ingestion.mjs` | Upsert market + append snapshot |
| `mapKalshiEventToCanonical()` | `lib/providers/kalshi-adapter.mjs` | Kalshi → CanonicalEvent |
| `mapPolymarketEventToCanonical()` | `lib/providers/polymarket-adapter.mjs` | Polymarket → CanonicalEvent |
| `buildApp()` | `src/server.mjs` | API server construction |
| `fetchKalshiPriceMap()` | `lib/providers/kalshi.mjs` | Kalshi price fetch |
| `fetchPolymarketPriceMap()` | `lib/providers/polymarket.mjs` | Polymarket price fetch |
