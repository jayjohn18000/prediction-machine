# Phase E1.5 — Sport Inference Fix + Runtime Hardening — Schema & Architecture

## Data Models

### No schema migrations required

All changes in E1.5 are application-level. The `sport` column already exists on `pmci.provider_markets` (added in E1.1). New sport codes (`lacrosse`, `wnba`, `darts`, `chess`) are free-text values — no enum constraint to update.

### New canonical sport codes introduced

```
Existing:  nfl, nba, mlb, nhl, ncaaf, ncaab, ncaa, mma, esports, soccer,
           tennis, golf, f1, boxing, motorsport, wrestling, basketball,
           rugby, cricket, olympics, hockey

New:       lacrosse, wnba, darts, chess, baseball (for NPB/KBO)
```

`baseball` is distinct from `mlb` — used for non-MLB professional baseball leagues (NPB Japan, KBO Korea). If this distinction isn't wanted, map them to `mlb` instead in the pattern table.

---

## Architecture Decisions

### Decision 1: Sport label passthrough vs. re-inference for Polymarket

**Choice:** Pass the sport label from the `/sports` endpoint through to ingestion, rather than fixing `inferSportFromPolymarketTags` to handle numeric IDs.

**Why:** The `/sports` endpoint already returns the authoritative sport classification. Re-inferring from numeric tag IDs would require maintaining a separate tagId→sport mapping that duplicates what the API already provides. The passthrough approach is simpler and stays in sync with Polymarket's own taxonomy automatically.

**Trade-off:** If the `/sports` endpoint changes its response format, we fall back to the (still-broken) tag inference. Acceptable because the fallback already doesn't work — we lose nothing.

### Decision 2: Max-runtime + incremental skip vs. parallelism

**Choice:** 30-minute max-runtime ceiling with series-level skip (based on `last_seen_at` within 6 hours) instead of parallelizing API requests.

**Why:** Parallelizing Kalshi API requests risks rate-limiting (already seeing 429s). The incremental approach is simpler, respects API rate limits by design, and distributes load across multiple scheduled runs. Full coverage happens in ~16 hours across 8 runs instead of one 16-hour run.

**Trade-off:** Any individual scheduled run only covers a fraction of series. A series updated 7+ hours ago might have stale prices until the next run covers it. For sports markets where prices move fast during game time, this is acceptable — game-day markets are high-activity and will be prioritized by the "least recently seen" ordering.

### Decision 3: Broad ticker prefix catches as last-resort fallback

**Choice:** Add `^KX.*MLB`, `^KX.*NBA` etc. as catch-all patterns at the END of `KALSHI_SERIES_TICKER_FALLBACK`.

**Why:** Kalshi's ticker naming convention embeds the league abbreviation in most sports tickers. Rather than enumerating every possible suffix (`KXMLBF5TOTAL`, `KXMLBF5SPREAD`, `KXMLBGAME`, `KXMLBLSTREAK`...), a broad prefix catch handles all current and future variants.

**Trade-off:** Risk of false positives if Kalshi creates a ticker like `KXMLBACTORS` (hypothetical non-sport). Mitigated by: (a) these only fire in the ticker fallback, after title matching fails, and (b) the series is already pre-filtered to `category='Sports'` by Kalshi.

---

## Dependencies

### External services
- Kalshi API: `https://api.elections.kalshi.com/trade-api/v2` (unchanged)
- Polymarket Gamma API: `https://gamma-api.polymarket.com` (unchanged)
- Polymarket `/sports` endpoint: `https://gamma-api.polymarket.com/sports` (already used since E1.4)

### Libraries
- No new dependencies. Uses Node built-in `test` runner for Step 4.

### Environment variables
- No changes. `DATABASE_URL` still the only required env var.

---

## File Change Summary

| File | Change type | Step |
|------|------------|------|
| `lib/ingestion/sports-universe.mjs` | Modify | 1, 5 |
| `lib/ingestion/services/sport-inference.mjs` | Modify | 2, 3 |
| `tests/sport-inference.test.mjs` | New | 4 |
| `scripts/ingestion/pmci-backfill-sport-codes.mjs` | New | 6 |
| `package.json` | Add script entry | 6 |
