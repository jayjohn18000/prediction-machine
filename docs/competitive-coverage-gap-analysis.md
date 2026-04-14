# Competitive coverage gap analysis (PMCI vs SimpleFunctions vs Oddpool)

**Purpose:** Use public and optional third-party APIs as **goalposts** for coverage and product shape -- not as ground truth. PMCI remains authoritative on your schema, audits, and links.

**Regenerate numbers:** `npm run pmci:benchmark:coverage`
Machine-readable output: `output/benchmark/last-run.json` (gitignored; contains no API keys).
Human summaries: `output/benchmark/pmci-internal-summary.md`, `output/benchmark/sf-summary.md`, `output/benchmark/oddpool-summary.md`.

---

## 1. Executive summary

- **PMCI** today is optimized for **high-precision cross-venue links** inside **politics** and **sports**, with very strong linking on **curated 2028 nominee** slices. The raw link rate across all `provider_markets` is low by design: most rows are sports contracts that are not comparable (moneyline vs totals vs BTTS), and politics has many non-overlapping contracts across venues.
- **SimpleFunctions** exposes a **~32.7k** screener universe mixing Kalshi and Polymarket with **multi-category** Kalshi rows (Economics, Crypto, Financials, Entertainment) in top-volume samples. That is a different product surface than PMCI's `market_families` + `market_links` + audit gates -- closer to "agent context + indicators" than "canonical matched contracts."
- **Oddpool** (sampled 2026-04-14 via `/search/events`) returns **100 events per category query** across Kalshi + Polymarket with event-level grouping. Top events (BTC EOY: 28 markets, CA Governor: 25 markets) show rich market depth per event. Premium tier exposes cross-venue **arbitrage** / **disagreement** APIs.

---

## 2. Side-by-side comparison

| Dimension | PMCI | SimpleFunctions | Oddpool (sampled) |
|-----------|------|-----------------|-------------------|
| Primary artifact | `market_families`, `market_links`, `proposed_links` | `/api/public/screen`, indicators per row | `/search/events`, `/search/markets`, `/arbitrage/*` |
| Venues | Kalshi + Polymarket | Kalshi + Polymarket | Kalshi + Polymarket |
| Pair definition | Audited equivalent/proxy links | Screener + diff/contagion views | Event search + matched feeds + arb (premium) |
| Scale | ~80.6k markets, ~3.2k families, ~357 links | ~32.7k universe | 100 events/query, top event = 28 markets |
| Categories | politics, sports | Politics, Crypto, Economics, Financials, Elections, Entertainment, Sports | politics, crypto, economics/macro, sports, weather, culture |

---

## 3. PMCI internal snapshot (from benchmark SQL, 2026-04-14)

| Metric | Value |
|--------|-------|
| provider_markets | 80,606 |
| Kalshi markets | 42,394 |
| Polymarket markets | 38,212 |
| market_families | 3,233 |
| current_links | 357 |
| proposed_links total | 63,163 |
| accepted | 159 |
| rejected | 62,999 |
| pending | 3 |

**Link rate by category:**

| Category | Total | Linked | Rate |
|----------|-------|--------|------|
| sports | 75,841 | 221 | 0.3% |
| politics | 4,643 | 32 | 0.7% |
| dem-nominee-2028 | 70 | 70 | 100% |
| rep-nominee-2028 | 52 | 34 | 65% |

**Top sports rejection reasons** (`skip_reason` field):
- `market_type_mismatch:moneyline_winner:totals` -- 34,740
- `market_type_mismatch:totals:btts` -- 9,096
- `market_type_mismatch:moneyline_winner:btts` -- 8,685

**Rejected confidence distribution:** 62,737 in the 0.0-0.1 bucket (bulk low-score sports candidates), 166 in 0.9-1.0 (manually rejected high-score).

---

## 4. SimpleFunctions observations (public endpoints)

- **`/api/public/screen`:** returns `totalUniverse`, `totalAfterFilter`, and rich per-market indicators (implied yield, cliff risk index, liquidity-adjusted spread, volatility ratio, overround). Category filters change `totalAfterFilter` dramatically (e.g. politics ≈1.1k).
- **`/api/public/diff?topic=...`:** returns `tickers` with price/spread/depth deltas -- a "what moved" reference, not validated cross-venue matches.
- **Product gap vs PMCI:** SF is strong at cross-venue discovery UX for agents. PMCI is strong at durable linkage in Postgres with review gates. Phase F execution-readiness metrics will bridge this gap.

---

## 5. Oddpool observations (sampled 2026-04-14)

**Event counts from search queries:**

| Query | Events | Kalshi | Polymarket | Markets (sum) |
|-------|--------|--------|------------|---------------|
| president | 46 | 17 | 29 | 124 |
| bitcoin | 100 | 17 | 83 | 851 |
| nba | 26 | 1 | 25 | 119 |
| fed rate | 100 | 93 | 7 | 896 |
| governor | 100 | 97 | 3 | 555 |
| senate | 100 | 92 | 8 | 520 |
| mlb | 30 | 0 | 30 | 363 |
| nhl | 25 | 10 | 15 | 284 |
| ethereum | 100 | 9 | 91 | 504 |
| soccer | 2 | 1 | 1 | 32 |
| mma | 0 | 0 | 0 | 0 |
| weather | 1 | 0 | 1 | 7 |
| recent | 100 | 96 | 4 | 432 |

**Key findings:**
- **Kalshi dominance in economics/politics:** fed rate (93 Kalshi / 7 Poly), governor (97/3), senate (92/8).
- **Polymarket dominance in crypto/sports:** bitcoin (17/83), ethereum (9/91), mlb (0/30), nba (1/25).
- **Cross-venue overlap candidates:** both venues present for bitcoin, nba, nhl, president, senate.
- **Event grouping:** Oddpool uses native exchange event IDs (`KXBTCY-27JAN0100`, `trump-out-as-president-before-2027`) with markets nested under events (Kalshi BTC EOY = 28 strike-level markets).

**Kalshi series Oddpool surfaces that PMCI does not ingest:**
- `KXBTCY`, `KXETHY`, `KXBTCMAX100`, `KXBTCMAXY` (crypto)
- `KXFEDDECISION`, `KXRATECUTCOUNT` (economics)
- `KXWTI`, `KXWTIW` (commodities/financials)
- `KXSURVIVOR` (entertainment)

---

## 6. Why PMCI shows "fewer pairs" than consumer comparators

1. **Different definition of "pair":** PMCI counts accepted, active `market_links` with high-bar `proposed_links`. Competitors show screener rows, topic diffs, or premium arb tables that are not equivalent to audited linkage.
2. **Ingestion scope:** PMCI does not yet ingest macro/crypto/econ/financials universes. E2 crypto is planned on the roadmap.
3. **Sports combinatorics:** cross-joining all Kalshi x Poly sports rows creates millions of candidates; `market_type_mismatch` filters correctly discard almost all of them.
4. **Politics reality:** genuine Kalshi-Poly overlap is sparse outside headline events (documented in `docs/system-state.md`).

---

## 7. Recommendations (actionable, PMCI-first)

### A. Ingestion expansion (priority order)

1. **E2 crypto** (already planned): align continuous/strike markets before chasing arb narratives. Oddpool shows 100+ bitcoin events, 100+ ethereum events with strong Polymarket presence.
2. **Economics / macro** (Kalshi-heavy + Poly): add a guard-first universe slice with explicit contract templates (Fed decisions, CPI prints, rate cuts). Oddpool shows 100 events for "fed rate" alone -- 93 from Kalshi.
3. **Financials / commodities** (optional): WTI, equities -- only after macro template pattern exists.

### B. Matching / proposer improvements

1. **Sports:** stratify proposals by `market_type` compatibility *before* scoring to cut DB noise. The 62.7k low-confidence rejects are mostly incompatible market types crossing each other.
2. **Politics:** consider event-level pre-grouping (Kalshi event ticker / Poly event slug) before candidate generation -- closer to Oddpool's "event contains markets" model.
3. **Review queue:** keep human/auto-accept discipline; use competitor APIs only as spot checks for missing verticals, not as automatic link imports.

### C. Benchmarking hygiene

1. Add `ODDPOOL_API_KEY` locally when you want Oddpool rows in `last-run.json` (see `.env.example`).
2. Re-run `npm run pmci:benchmark:coverage` after major ingest or proposer changes.
3. Archive `last-run.json` offline if you want historical trends (file is gitignored by default).

---

## 8. References

- Oddpool API docs: [https://docs.oddpool.com/llms.txt](https://docs.oddpool.com/llms.txt)
- SimpleFunctions: [https://simplefunctions.dev](https://simplefunctions.dev)
- PMCI roadmap / system state: [`docs/roadmap.md`](roadmap.md), [`docs/system-state.md`](system-state.md)
- Benchmark script: [`scripts/benchmark/coverage-benchmark.mjs`](../scripts/benchmark/coverage-benchmark.mjs)
- Oddpool raw samples: `output/benchmark/oddpool-*.json`
- SimpleFunctions raw samples: `output/benchmark/sf-*.json`
