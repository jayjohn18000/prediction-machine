# Prediction Machine — Consolidated Audit & Acceleration Plan

**Date:** 2026-04-13  
**Reports:**
- `01-repo-blocker-audit.md` — Pipeline blockers, sports gap analysis, dependency map
- `02-external-market-coverage-audit.md` — Kalshi/Polymarket API gaps, missing markets
- `03-dev-acceleration-roadmap.md` — 30/60/90 plan, architecture, agent practices

---

## Top 10 Blockers Across All Workstreams (Ranked)

| # | Blocker | Source | Severity | Est. Effort | Revenue Impact |
|---|---------|--------|----------|-------------|----------------|
| 1 | **Proposal engine hardcoded to `category='politics'`** — 1,234-line monolith with politics-specific topic signatures, blocking/scoring, and entity parsing. Sports/crypto cannot use it. | Report 1, P0-1 | P0 | 12–16h | Blocks all non-politics revenue |
| 2 | **Observer locked to static `event_pairs.json`** — 31 political pairs, no mechanism to observe sports or any DB-discovered markets. Universe ingestion writes to PMCI tables but observer never reads them. | Reports 1+2 | P0 | 8–10h | No real-time sports/crypto signals |
| 3 | **No category-agnostic market discovery** — Each category requires a dedicated ingestion script, env vars, proposer adaptation, and audit gate. Crypto/economics/weather have zero coverage by design. | Report 2 | P0 | 16–24h | Zero non-politics/sports revenue surface |
| 4 | **Sports proposer has no auto-accept** — Every sports link requires manual CLI review. Even high-confidence matchup-key + sport + date matches sit in `proposed_links` forever. | Report 1, P0-3 | P0 | 4–6h | Sports intelligence pipeline dead |
| 5 | **No sports spread/signal computation** — Even if sports markets were linked, no code computes Kalshi-vs-Polymarket spread or edge for sports families. | Report 1, P0-4 | P0 | 6–8h | No sports execution signals |
| 6 | **PMCI sweep ignores `status='active'`** — Sports markets from both Kalshi and Polymarket are ingested with `status='active'`, but the sweep only refreshes `status='open'` or NULL. Sports prices go stale between batch runs. | Report 1, P1-5 | P1 | **0.5h** | Sports prices always stale |
| 7 | **Kalshi MVE events silently excluded** — `GET /events` excludes multivariate events by default. No code calls `GET /events/multivariate` or sets `mve_filter`. High-volume sports/political markets may be invisible. | Report 2 | P1 | 3–4h | Unknown market coverage gap |
| 8 | **Polymarket bid/ask not parsed for sports** — Sports ingestion writes `priceYes` (midpoint) but not `bestBid`/`bestAsk`. Spread computation limited to midpoint, creating phantom arbitrage. | Report 1, P1-4 | P1 | **1–2h** | Overstated edges, no executable spread |
| 9 | **Sports team name normalization is regex-only** — Single regex for "Team A vs Team B" misses "Team A - Team B", abbreviations, and variant formats. Many markets get `matchupKey='unknown'` and are dropped by the proposer. | Report 1, P1-1 | P1 | 4–6h | Sports matches missed |
| 10 | **No test runner or CI** — `package.json` has no `test` script. 28 test files exist but are never run automatically. No GitHub Actions. Refactoring is high-risk without automated regression detection. | Report 3 | P1 | **1–2h** | Dev velocity and safety |

---

## Recommended Execution Plan: Next 7 Days

### Day 1 — Quick wins (3 hours total)

| Task | File | Effort | Unblocks |
|------|------|--------|----------|
| Fix PMCI sweep status filter to include `'active'` | `lib/ingestion/pmci-sweep.mjs:16` | 0.5h | Sports price freshness |
| Add `bestBid`/`bestAsk` parsing for Polymarket sports | `lib/ingestion/sports-universe.mjs:410` | 1h | Executable spread computation |
| Add `npm test` script to `package.json` | `package.json` | 0.5h | Automated regression detection |
| Increase retry attempts from 2→4 for provider fetches | `lib/providers/kalshi.mjs:26`, `polymarket.mjs:20` | 0.5h | Reliability under transient failures |

### Day 2 — Sports auto-accept (4–6 hours)

| Task | File | Effort | Unblocks |
|------|------|--------|----------|
| Add auto-accept to sports proposer for `confidence >= 0.95` + matching `sport` + `matchupKey` + `game_date` | `scripts/review/pmci-propose-links-sports.mjs` | 4–6h | Automated sports link creation |

### Day 3 — Sports audit stabilization (4 hours)

| Task | File | Effort | Unblocks |
|------|------|--------|----------|
| Re-run stale-cleanup for 8,317 stale active sports markets | `scripts/stale-cleanup.mjs` | 1h | Sports audit green |
| Re-run sport inference backfill for 1,663 unknown sports | `scripts/backfill-sport-inference.mjs` | 1h | Sports proposer coverage |
| Fix Polymarket sport inference for numeric tag IDs | `lib/ingestion/services/sport-inference.mjs:217` | 2h | Polymarket sport classification |

### Day 4 — Observer bridge to DB (6–8 hours)

| Task | File | Effort | Unblocks |
|------|------|--------|----------|
| Add DB-driven observation path: after static-pair cycle, query `pmci.market_links` for sports families and fetch fresh prices | `observer.mjs`, `lib/ingestion/observer-cycle.mjs` | 6–8h | Real-time sports price tracking |

### Day 5 — Sports signal pipeline (6 hours)

| Task | File | Effort | Unblocks |
|------|------|--------|----------|
| Compute spread/edge for linked sports families, write to `prediction_market_spreads` or sports signals table | `lib/ingestion/observer-cycle.mjs` or new `lib/ingestion/sports-signal.mjs` | 6h | Sports execution signals |

### Day 6 — External coverage expansion (4 hours)

| Task | File | Effort | Unblocks |
|------|------|--------|----------|
| Add Kalshi MVE endpoint queries | `lib/ingestion/universe.mjs`, `lib/ingestion/sports-universe.mjs` | 2h | Hidden market discovery |
| Increase `PMCI_POLITICS_MAX_EVENTS_PER_PROVIDER` to 500+ | `.env` | 0.5h | Politics coverage completeness |
| Add concurrent series fetching for sports (5-parallel) | `lib/ingestion/sports-universe.mjs` | 1.5h | Faster sports ingestion |

### Day 7 — CI + documentation (4 hours)

| Task | File | Effort | Unblocks |
|------|------|--------|----------|
| Create GitHub Actions CI (test + verify:schema) | `.github/workflows/ci.yml` | 1h | Automated quality gate |
| Write per-module CONTEXT.md files (matching, ingestion, providers, routes, services) | `lib/*/CONTEXT.md` | 2h | Agent session productivity |
| Update CLAUDE.md with session quick-start checklist | `CLAUDE.md` | 1h | Agent session orientation |

---

## Architecture: What Exists vs What's Needed

```
                    EXISTS                              NEEDED
                    ══════                              ══════

  ┌─────────────────────┐            ┌────────────────────────────────┐
  │ Politics observer    │            │ Multi-category observer        │
  │ (31 static pairs)   │     →      │ (DB-driven from market_links)  │
  └─────────────────────┘            └────────────────────────────────┘

  ┌─────────────────────┐            ┌────────────────────────────────┐
  │ Politics universe    │            │ Category-agnostic ingester     │
  │ Sports universe      │     →      │ with pluggable source adapters │
  │ (881 + 523 lines,   │            │ and shared fetch→upsert loop   │
  │  duplicated logic)   │            └────────────────────────────────┘
  └─────────────────────┘

  ┌─────────────────────┐            ┌────────────────────────────────┐
  │ Politics proposal    │            │ Generic proposal engine with   │
  │ engine (1,234 lines, │     →      │ pluggable MatchingProfile per  │
  │  politics-only)      │            │ category (politics, sports,    │
  └─────────────────────┘            │ crypto, economics)             │
                                     └────────────────────────────────┘

  ┌─────────────────────┐            ┌────────────────────────────────┐
  │ Raw spread data      │            │ Tradability model + fee-adj    │
  │ (no fee adjustment)  │     →      │ edge + ranked signals API      │
  └─────────────────────┘            └────────────────────────────────┘

  ┌─────────────────────┐            ┌────────────────────────────────┐
  │ Manual scripts       │            │ CI/CD + alerting + monitoring  │
  │ (50+ scripts,        │     →      │ + process manager + crash      │
  │  no automation)      │            │ recovery                       │
  └─────────────────────┘            └────────────────────────────────┘
```

---

## Key Findings by Theme

### Sports (from Reports 1 + 2)
- Ingestion works. Matching is broken. Execution doesn't exist.
- The sports proposer exists but creates proposals that rot without review.
- Team name normalization drops many markets (`matchupKey='unknown'`).
- Polymarket sport inference fails on numeric tag IDs.
- The sweep ignores sports markets (status filter mismatch).
- No bid/ask for Polymarket sports — can't compute real spread.

### Market Coverage (from Report 2)
- Static `event_pairs.json` is the #1 structural bottleneck — only 31 political pairs tracked.
- Kalshi MVEs completely invisible (never queried).
- Polymarket offset pagination may truncate large result sets.
- `maxEvents=50` default silently caps politics discovery.
- Comparing Kalshi ask/bid to Polymarket midpoint overstates spread.
- No category-agnostic discovery — every category is a new build.

### Development Velocity (from Report 3)
- No CI/CD at all. 28 test files exist but never run automatically.
- Each agent session spends 15+ minutes on orientation.
- Proposal engine is a monolith that can't be safely extended.
- Ingestion logic is copy-pasted across categories.
- No execution layer code exists — the path from intelligence to money is unbuilt.

---

## The Revenue-Critical Path

```
 NOW                        WEEK 1                      WEEKS 2-4
 ═══                        ══════                      ═════════

 Sports ingested     →  Fix sweep + auto-accept  →  Sports spreads live
 but not linked          + observer bridge            + execution signals

 Politics works      →  Increase coverage caps   →  Full political coverage
 but coverage capped     + MVE endpoints

 No execution layer  →  (no change week 1)       →  Phase F: tradability
                                                      model + ranked signals

 No crypto/econ      →  (no change week 1)       →  Adapter extraction
                                                      enables fast category add
```

The fastest path to revenue is: **fix the 0.5-hour sweep bug → auto-accept sports links → bridge observer to DB → compute sports spreads → Phase F tradability model**.

---

## Reports Index

| File | Contents | Lines |
|------|----------|-------|
| `output/01-repo-blocker-audit.md` | 16 prioritized blockers, pipeline map, sports gap analysis, dependency map, "fix now" shortlist | ~455 |
| `output/02-external-market-coverage-audit.md` | Kalshi/Polymarket API deep dives, 12-item mismatch checklist, failure modes, endpoint tests, normalization pitfalls | ~561 |
| `output/03-dev-acceleration-roadmap.md` | 30/60/90-day plan, module architecture, agent practices, next 5 commits, testing strategy, infrastructure gaps | ~532 |
| `output/00-consolidated-summary.md` | This file — top 10 blockers, 7-day execution plan, architecture gap map | — |
