# SimpleFunctions public API — benchmark snapshot

Sources: live `GET https://simplefunctions.dev/api/public/*` calls from `scripts/benchmark/coverage-benchmark.mjs` plus cached JSON under `output/benchmark/sf-*.json` from an earlier pull (2026-04-14).

## Universe scale (`/api/public/screen`)

| Query | totalUniverse | totalAfterFilter | Notes |
|--------|---------------|------------------|--------|
| Top volume, `excludeSports=false` | 32,654 | 22,823 | Default table still applies `excludeSports: true` in the returned `filters` for this endpoint variant in some responses; confirm per response. |
| `category=politics` | 32,654 | 1,106 | Politics slice after SF filters. |
| `category=crypto` / `economics` / `sports` | (see `last-run.json`) | | Run `npm run pmci:benchmark:coverage` for current numbers. |

Top-100 volume sample (`screen_all`): mixed **Polymarket** and **Kalshi**; Kalshi rows in that sample carry categories such as **Economics**, **Politics**, **Elections**, **Financials**, **Crypto**, **Entertainment** — i.e. a **multi-vertical** universe in one screener, unlike PMCI’s current `politics` + `sports` ingestion focus.

## Cross-venue / divergence style endpoints

- `/api/public/diff?topic=iran` returns a time window and a **`tickers`** array (per-venue movers and microstructure stats), not PMCI-style `proposed_links`.
- `/api/public/contagion?window=24h` returns structured “gap” style objects (shape may vary); the benchmark script records `gapCount` when it finds a known array field.

## Product implications vs PMCI

- SF optimizes for **agent context**: one screener across venues, rich **indicators** (e.g. implied yield, liquidity, volatility proxies) on each row.
- PMCI optimizes for **canonical families**, **market_links**, and **auditability** of cross-venue equivalence — a different layer. Closing the “pair count gap” is not only embedding similarity; it is also **ingesting the same verticals** competitors surface as first-class.
