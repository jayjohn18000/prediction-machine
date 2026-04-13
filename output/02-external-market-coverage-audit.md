# External Market Coverage Audit — Prediction Machine PMCI

> Generated: 2026-04-13
> Scope: Kalshi + Polymarket ingestion completeness audit
> Evidence: Code audit of `prediction-machine/` + Kalshi/Polymarket API documentation research

---

## 1. Executive Summary

The Prediction Machine is missing markets for **five structural reasons**:

1. **The observer (`observer.mjs`) only tracks markets manually listed in `event_pairs.json`** — a static file of ~60 political candidate entries. Any market not in this file is invisible to the core spread observation loop.

2. **The universe ingestion pipeline (`lib/ingestion/universe.mjs`) is hardcoded to "politics"** — it filters by `isLikelyPoliticsText()` regex and requires `PMCI_POLITICS_KALSHI_SERIES_TICKERS` / `PMCI_POLITICS_POLY_TAG_ID` env vars scoped to political markets only. Sports ingestion exists (`sports-universe.mjs`) but runs on a separate 4-hour schedule with no cross-platform matching pipeline equivalent to politics.

3. **No category-agnostic market discovery exists.** Crypto, economics, entertainment, weather, and other categories have zero ingestion code. Each new category requires building a dedicated ingestion script, env configuration, and proposer adaptation.

4. **Kalshi multivariate events (MVEs) are silently excluded.** The `GET /events` endpoint excludes MVEs by default ([Kalshi docs](https://docs.kalshi.com/api-reference/events/get-events)), and no code queries the separate `GET /events/multivariate` endpoint.

5. **Polymarket cursor-based pagination is not used.** The Gamma API now offers a [keyset pagination endpoint](https://docs.polymarket.com/api-reference/events/list-events-keyset-pagination) that rejects `offset` and requires `next_cursor`/`after_cursor`. The code uses the older offset-based pattern, which may silently truncate results for large result sets.

---

## 2. Kalshi API Deep Dive

### 2.1 Event vs Market Semantics

Kalshi uses a three-level hierarchy:

| Level | Description | Example |
|-------|-------------|---------|
| **Series** | Template for recurring events | "NFL Win Totals", "Presidential Nominee" |
| **Event** | Specific instance of a series | "KXNFLWINS-ATL" (Falcons win total) |
| **Market** | Tradeable contract within an event | "KXNFLWINS-ATL-O8.5" (Falcons over 8.5 wins) |

Key endpoints:
- `GET /series` — returns all series (up to 10k), each with a `category` field (e.g., `"Sports"`, `"Politics"`)
- `GET /events` — returns events, filterable by `series_ticker`. **Excludes MVEs by default.**
- `GET /markets` — returns markets, filterable by `event_ticker`
- `GET /events/multivariate` — separate endpoint for MVE events
- `GET /multivariate_event_collections/{collection_ticker}` — specific MVE collection ([docs](https://docs.kalshi.com/api-reference/collection/get-multivariate-event-collections))
- `GET /search/tags_by_categories` — tags organized by series category ([docs](https://docs.kalshi.com/api-reference/search/get-tags-for-series-categories))

### 2.2 Market Lifecycle States

Source: [Kalshi Market Lifecycle docs](https://docs.kalshi.com/websockets/market-&-event-lifecycle)

```
created → activated → [deactivated ↔ activated] → determined → settled
                                                      ↑
                                              close_date_updated
```

The `GET /markets` endpoint supports filtering by `status` ([docs](https://docs.kalshi.com/api-reference/market/get-markets)):
- **`unopened`** — created but not yet tradeable
- **`open`** — actively tradeable
- **`closed`** — trading ended, awaiting resolution
- **`settled`** — resolved, payouts complete

Only **one** status filter per request. The default (no filter) returns all statuses.

Compatible timestamp + status filter combinations:

| Timestamp Filters | Compatible Status |
|-------------------|-------------------|
| `min_created_ts`, `max_created_ts` | `unopened`, `open`, or empty |
| `min_close_ts`, `max_close_ts` | `closed` or empty |
| `min_settled_ts`, `max_settled_ts` | `settled` or empty |
| `min_updated_ts` | Empty only |

### 2.3 Pagination

Kalshi uses **cursor-based pagination** ([docs](https://docs.kalshi.com/getting_started/pagination)):
- `limit`: max 200 per page (default 200)
- `cursor`: opaque token from previous response
- Pagination ends when `cursor` is `null`

### 2.4 Rate Limits

Four tiers ([docs](https://docs.kalshi.com/getting_started/rate_limits)):

| Tier | Read/sec | Write/sec | Qualification |
|------|----------|-----------|---------------|
| Basic | 20 | 10 | Completing signup |
| Advanced | 30 | 30 | Application form |
| Premier | 100 | 100 | 3.75% monthly volume + technical review |
| Prime | 400 | 400 | 7.5% monthly volume + technical review |

The code uses a 250ms delay (`PMCI_POLITICS_REQUEST_DELAY_MS`), which is ~4 req/sec — well within Basic tier but potentially too slow for full ingestion.

### 2.5 What the Code Currently Fetches vs What It Should Fetch

#### Observer (`lib/providers/kalshi.mjs`)
- **Currently:** Fetches `GET /markets?event_ticker={ticker}&limit=1000` for each event in `event_pairs.json`. No status filter, no category filter, no series discovery.
- **Gap:** Only sees markets for events explicitly listed in the static config. No discovery of new events or series.

#### Politics Universe (`lib/ingestion/universe.mjs`)
- **Currently:** Fetches `GET /events?series_ticker={ticker}&limit=200` using cursor pagination for tickers in `PMCI_POLITICS_KALSHI_SERIES_TICKERS`. Then fetches `GET /markets?event_ticker={et}&limit=1000` per event. Applies `isLikelyPoliticsText()` filter that drops any market not containing political keywords.
- **Gap:** Hard-filtered to politics. No `status` filter on events — may process settled events wastefully. No MVE support.

#### Sports Universe (`lib/ingestion/sports-universe.mjs`)
- **Currently:** Fetches `GET /series?limit=10000`, filters by `category === 'Sports'`. Iterates events/markets per series. Skips non-`active`/`open` markets.
- **Gap:** No pagination fallback for >10k series. No `min_updated_ts` for incremental updates. Max 20 event pages per series (`evPage > 20` at line 252).

#### Missing entirely:
- `GET /events/multivariate` — MVE markets never queried
- Any query for crypto, economics, weather, entertainment, or other Kalshi categories
- `GET /search/tags_by_categories` — never used for discovery

---

## 3. Polymarket API Deep Dive

### 3.1 Event/Market/Condition Discovery Patterns

Polymarket uses a two-API architecture:

| API | Base URL | Purpose | Auth Required |
|-----|----------|---------|---------------|
| **Gamma API** | `https://gamma-api.polymarket.com` | Market discovery, metadata, prices | No |
| **CLOB API** | `https://clob.polymarket.com` | Order books, trading | Wallet-based |

Key Gamma API endpoints:
- `GET /events` — list events with filters (offset-based pagination)
- `GET /events/keyset` — list events with cursor-based pagination ([docs](https://docs.polymarket.com/api-reference/events/list-events-keyset-pagination))
- `GET /events/slug/{slug}` — single event by slug (includes nested markets)
- `GET /markets` — list markets with filters
- `GET /tags` — list all tags
- `GET /sports` — sports metadata with tag IDs ([docs](https://docs.polymarket.com/api-reference/sports/get-sports-metadata-information))
- `GET /public-search` — full-text search across events

Data model:
- **Event** = top-level question (e.g., "2028 Democratic Presidential Nominee")
- **Market** = tradeable binary outcome within an event (e.g., "Gavin Newsom wins nomination")
- Each market has a `conditionId` (on-chain identifier) and `clobTokenIds` (Yes/No token pair)

### 3.2 CLOB vs Gamma API Differences

| Feature | Gamma API | CLOB API |
|---------|-----------|----------|
| Discovery | Full event/market metadata | Order books, trades |
| Prices | `outcomePrices` (midpoint-ish) | Live bid/ask depth |
| Auth | None | Wallet signature |
| Rate limits | Moderate (undocumented) | Stricter per-wallet |
| Best for | Ingestion, metadata | Trading, live spreads |

The code only uses the Gamma API, which is correct for discovery. However, `outcomePrices` from Gamma is a **stringified JSON array** (not native JSON), which has caused parse errors. The E1.4 fix in `sports-universe.mjs` (line 389-393) addresses this but the fix is not applied consistently in all code paths.

### 3.3 Filters for Enumerating All Markets

To enumerate all active markets:
```
GET /events?active=true&closed=false&limit=100&offset=0
```

Or with the newer keyset endpoint:
```
GET /events/keyset?closed=false&limit=500&after_cursor={token}
```

Key filter parameters ([docs](https://docs.polymarket.com/api-reference/markets/list-markets)):
- `active` / `closed` / `archived` — lifecycle filters
- `tag_id` — filter by category tag
- `volume_num_min` / `liquidity_num_min` — filter by activity
- `start_date_min/max`, `end_date_min/max` — date ranges
- `order` — sort by `volume_24hr`, `volume`, `liquidity`, `start_date`, `end_date`, `competitive`

### 3.4 What the Code Currently Fetches vs What It Should Fetch

#### Observer (`lib/providers/polymarket.mjs`)
- **Currently:** Fetches `GET /events/slug/{slug}` for each slug in `event_pairs.json`. Matches outcomes by checking if `market.question.includes(pair.polymarketOutcomeName)`.
- **Gap:** Only sees events listed in static config. No discovery. No pagination within event.

#### Politics Universe (`lib/ingestion/universe.mjs`)
- **Currently:** Fetches `GET /events?tag_id={id}&active=true&closed=false&limit=50&offset={n}` using `PMCI_POLITICS_POLY_TAG_ID`. Also does keyword search via `/public-search`. Caps at `maxEvents` (default 50). Uses `isLikelyPoliticsText()` filter.
- **Gap:** Hard-filtered to politics tag. Default `maxEvents=50` severely limits discovery. Offset-based pagination may miss events. No cursor-based pagination.

#### Sports Universe (`lib/ingestion/sports-universe.mjs`)
- **Currently:** Fetches `/sports` for tag discovery, then `GET /markets?tag_id={id}&closed=false&archived=false&limit=100&offset={n}` per sport tag.
- **Gap:** Uses `/markets` not `/events` — misses event-level grouping needed for cross-platform matching. No equivalent of the proposer for creating cross-platform links.

#### Missing entirely:
- `GET /events/keyset` — cursor-based pagination endpoint
- Queries without a `tag_id` filter (full market enumeration)
- Crypto, economics, entertainment, weather tags

---

## 4. API/Query Mismatch Checklist

| # | Check | Status | File:Line | Impact |
|---|-------|--------|-----------|--------|
| 1 | Observer only reads from static `event_pairs.json` | **CONFIRMED** | `observer.mjs:34-35` | All non-listed events invisible |
| 2 | Config contains only 2028 presidential nominee markets | **CONFIRMED** | `scripts/prediction_market_event_pairs.json` | No sports, crypto, economics, Senate, House, Governor |
| 3 | Politics universe requires `isLikelyPoliticsText()` regex | **CONFIRMED** | `lib/ingestion/universe.mjs:47-50` | Non-political markets silently dropped |
| 4 | Politics universe caps at 50 events per provider | **CONFIRMED** | `universe.mjs:753` | Misses events beyond cap |
| 5 | Kalshi MVE events never queried | **CONFIRMED** | No `GET /events/multivariate` anywhere | All multivariate markets invisible |
| 6 | No `status` filter on Kalshi event queries in universe | **CONFIRMED** | `universe.mjs:282-284` | Wastes budget on settled events |
| 7 | Sports has no cross-platform matching proposer | **CONFIRMED** | `sports-universe.mjs` ingests, doesn't match | Sports markets not linked for arb |
| 8 | Polymarket offset pagination may truncate | **LIKELY** | `universe.mjs:443-463` | Large tag results incomplete |
| 9 | No category-agnostic discovery mode | **CONFIRMED** | Architecture review | Crypto, economics, weather = zero coverage |
| 10 | `outcomePrices` string parsing inconsistency | **PARTIAL FIX** | Fixed in `sports-universe.mjs:389-393` | Price parse failures in some paths |
| 11 | Sports ingestion max 20 event pages per series | **CONFIRMED** | `sports-universe.mjs:252` | Large series may truncate |
| 12 | No `mve_filter` param used in Kalshi queries | **CONFIRMED** | All Kalshi fetches | MVE markets silently excluded |

---

## 5. Most Likely Failure Modes (Ranked by Probability)

### 5.1 Why Sports Markets Are Missed — **HIGH PROBABILITY**

**Root cause: No cross-platform sports matching pipeline.**

Sports ingestion (`sports-universe.mjs`) writes to `pmci.provider_markets` with `category='sports'`, but:

1. **Sports markets are not in `event_pairs.json`**, so the core observer never price-tracks them. The PMCI sweep (`pmci-sweep.mjs`) snapshots already-known markets but is a catch-up mechanism, not primary ingestion.

2. The sports proposer (`pmci:propose:sports`) exists but is structurally separate. Latest audit (2026-04-13) shows `stale_active=8,317` and `semantic_violations=369` — the pipeline is not healthy.

3. **Team name normalization is a hard problem.** Kalshi uses event tickers like `KXNFLWINS-ATL` while Polymarket uses slugs like `atlanta-falcons-win-total`. No mapping table exists to resolve `ATL` → `Atlanta Falcons`.

4. **Game date alignment**: Sports markets are short-lived (days). The proposer must match on `game_date` within 1 day, but `game_date` is derived from `close_time` (Kalshi) or `endDate` (Polymarket) which may differ by hours.

### 5.2 Why Proposed/Accepted Events Don't Show Up — **HIGH PROBABILITY**

**Root cause: Static configuration files and disconnected pipelines.**

The observer reads from `scripts/prediction_market_event_pairs.json` (60 entries, all 2028 presidential nominees). Markets that exist on Kalshi/Polymarket (Senate races, Governor races, House races, etc.) are:

1. Not in `event_pairs.json` → not tracked by observer
2. Ingested by `universe.mjs` if they match politics keywords → written to `pmci.provider_markets` → proposed by `proposal-engine.mjs` → **but never added back to the observer's price-tracking loop**

There is a critical disconnect: `proposal-engine.mjs` creates `market_links` and `market_families`, but the observer only reads `event_pairs.json`. The PMCI sweep partially bridges this gap but only snapshots already-known markets, and only if they have `status='open'` and lack a recent snapshot.

### 5.3 Why Category Coverage Is Incomplete — **CERTAIN**

**Root cause: Category-per-category build approach (by design).**

Per `docs/roadmap.md`, the system follows strict phase gates:
- Phase D = Politics (complete)
- Phase E1 = Sports (mostly complete, stabilization ongoing)
- Phase E2 = Crypto (planning, not implemented)
- No phase defined for economics, weather, entertainment, culture

Each category requires: (1) a dedicated ingestion script with env vars and API filters, (2) a dedicated proposer adaptation with topic signatures and guards, (3) a strict audit packet passing zero violations. This is architecturally sound for quality but guarantees **zero coverage** for any unconfigured category.

### 5.4 Why Kalshi MVE Markets Are Missed — **MEDIUM-HIGH PROBABILITY**

**Root cause: `GET /events` excludes MVEs by default.**

Per [Kalshi docs](https://docs.kalshi.com/api-reference/events/get-events), `GET /events` returns "all events excluding multivariate events." The separate endpoints (`GET /events/multivariate`, `GET /multivariate_event_collections/{collection_ticker}`) are never called anywhere in the codebase. If Kalshi is offering sports or other markets as MVEs, they are completely invisible.

Additionally, the `GET /markets` endpoint accepts an `mve_filter` parameter to include or exclude MVE markets — this parameter is never set in any API call.

### 5.5 Why Polymarket Results May Be Incomplete — **MEDIUM PROBABILITY**

**Root cause: Offset-based pagination, provider caps, and API evolution.**

The politics universe uses `offset` pagination with Polymarket's `/events` endpoint. The newer [keyset endpoint](https://docs.polymarket.com/api-reference/events/list-events-keyset-pagination) **rejects** `offset` (returns 422). The older offset-based endpoint still works but may have consistency issues for large result sets (events created/deleted during pagination shift offsets).

Additionally, `PMCI_POLITICS_MAX_EVENTS_PER_PROVIDER` defaults to 50, capping how many events are processed. A tag with 200+ events silently loses 150.

---

## 6. Endpoint/Filter Combinations to Test

### 6.1 Kalshi — Full Category Discovery

```bash
# Tags organized by category (discover all available categories)
curl "https://api.kalshi.com/trade-api/v2/search/tags_by_categories"

# All series with category counts
curl "https://api.kalshi.com/trade-api/v2/series?limit=10000" \
  | jq '[.series[].category] | group_by(.) | map({category: .[0], count: length})'
```

### 6.2 Kalshi — MVE Discovery (currently missing)

```bash
# List multivariate event collections
curl "https://api.kalshi.com/trade-api/v2/multivariate_event_collections"

# List MVE events (separate from regular events endpoint)
curl "https://api.kalshi.com/trade-api/v2/events/multivariate?limit=200"
```

### 6.3 Kalshi — Status-Filtered Markets

```bash
# Only open (tradeable) markets — avoids wasting budget on settled
curl "https://api.kalshi.com/trade-api/v2/markets?status=open&limit=200"

# Recently updated markets (incremental sync)
curl "https://api.kalshi.com/trade-api/v2/markets?min_updated_ts=$(date -v-1H +%s)&limit=200"

# Sports series events
curl "https://api.kalshi.com/trade-api/v2/events?series_ticker=KXNFLWINS&limit=200"
```

### 6.4 Polymarket — Full Enumeration

```bash
# All active events (no tag filter) — first page
curl "https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&offset=0"

# Cursor-based pagination (more reliable for large sets)
curl "https://gamma-api.polymarket.com/events/keyset?closed=false&limit=500"

# Sports metadata (all sport→tag_id mappings)
curl "https://gamma-api.polymarket.com/sports"

# All tags for category discovery
curl "https://gamma-api.polymarket.com/tags?limit=500&offset=0"
```

### 6.5 Polymarket — Category-Specific

```bash
# Crypto events by tag
curl "https://gamma-api.polymarket.com/events?tag_id=crypto&active=true&closed=false&limit=100"

# Search for specific market types
curl "https://gamma-api.polymarket.com/public-search?q=bitcoin%20price&limit_per_type=20"

# Polymarket US sports endpoint (separate from Gamma)
curl "https://gateway.polymarket.us/v2/sports/basketball/events?limit=100"
```

### 6.6 Cross-Platform Overlap Measurement

```bash
# Kalshi: count open markets by category
curl "https://api.kalshi.com/trade-api/v2/series?limit=10000" | \
  jq '.series | group_by(.category) | map({cat: .[0].category, n: length}) | sort_by(-.n)'

# Polymarket: top tags by volume
curl "https://gamma-api.polymarket.com/tags?limit=100" | \
  jq 'sort_by(-.volume) | .[0:20] | .[] | {slug, id, label}'
```

---

## 7. Cross-Platform Normalization Pitfalls

### 7.1 Entity Name Mismatches

| Issue | Kalshi Example | Polymarket Example | Impact |
|-------|----------------|--------------------|----|
| Team abbreviations | `ATL`, `BOS`, `LAL` | `atlanta-hawks`, `boston-celtics` | No mapping table exists |
| Candidate name variants | `KXPRESNOMR-28-RFK` | `Robert F. Kennedy Jr.` | Handled for politics via `entity-parse.mjs`, not for other categories |
| Ticker encoding | Dash-delimited codes | Slug-delimited human-readable | Structurally incompatible without domain-specific parsers |
| Event grouping | Series → Events → Markets | Events → Markets (flat) | Different nesting requires multi-level alignment |

### 7.2 Resolution Definition Differences

Per [cross-platform arbitrage research](https://predictionmarketspicks.com/articles/cross-platform-arbitrage-prediction-markets):
- Kalshi is CFTC-regulated with strict binary resolution rules
- Polymarket is crypto-based with community-influenced resolution
- Same event may resolve differently due to: timezone differences, authoritative data source differences, or definition edge cases (e.g., "win" includes overtime on one platform but not another)

### 7.3 Timing Asymmetries

- **Close time ≠ game time**: Kalshi `close_time` may be hours before game start; Polymarket `endDate` may be post-game
- **Settlement timing**: One platform may settle same-day; the other may take 24-48 hours
- **Market opening**: Kalshi sports markets may open days before Polymarket equivalents (or vice versa)

### 7.4 Price Semantics

- Kalshi returns `yes_ask_dollars` and `yes_bid_dollars` — actual order book prices
- Polymarket Gamma returns `outcomePrices` — a derived midpoint, not a live bid/ask
- **Comparing Kalshi ask to Polymarket midpoint overstates true spread**
- The code (`observer-cycle.mjs:44-45`) uses `yesAsk ?? yesBid` for Kalshi and `outcomePrices[0]` for Polymarket — not apples-to-apples
- The CLOB API (`clob.polymarket.com`) provides real bid/ask but requires wallet auth

### 7.5 Market Structure Differences

- **Binary markets**: Kalshi = one market per outcome. Polymarket = one market with Yes/No tokens.
- **Multi-outcome events**: Kalshi uses MVE collections. Polymarket uses grouped markets under one event with `groupItemTitle` per candidate/outcome.
- **The code handles this differently per path**: `ingestPair()` (in `pmci-ingestion.mjs`) handles paired binary markets; `ingestProviderMarket()` handles single-outcome markets with candidate name extraction.

### 7.6 Fee-Adjusted Edge

Per research, displayed spreads may not be tradeable:
- Kalshi charges variable fees up to 3% ([source](https://predictionmarketspicks.com/articles/cross-platform-arbitrage-prediction-markets))
- Polymarket charges ~1.5% taker fees
- A 5-cent displayed spread may have zero or negative net edge after fees
- The current system computes raw spread only — no fee adjustment exists (planned for Phase F per roadmap)

---

## 8. Recommendations (Prioritized)

### P0 — Critical (address first)

#### 8.1 Build a Category-Agnostic Market Discovery Layer

Replace the per-category ingestion approach with a two-stage pipeline:

**Stage 1 — Full enumeration (no category filter):**
- Kalshi: `GET /series?limit=10000` → for each series, `GET /events` → `GET /markets`
- Kalshi: `GET /events/multivariate?limit=200` → for each MVE, markets
- Polymarket: `GET /events/keyset?closed=false&limit=500` → paginate with `next_cursor`

**Stage 2 — Category classification:**
After ingestion, classify by inspecting series category (Kalshi), tags (Polymarket), and title keywords. Store `category` in `pmci.provider_markets` for downstream filtering.

**Why P0:** Without this, every new category requires building a new ingestion script from scratch. The current architecture cannot "catch ALL tradeable markets" by design.

**Files to modify:** New script `lib/ingestion/full-universe.mjs` or refactor `universe.mjs` to accept category as a parameter rather than hardcoding politics.

#### 8.2 Query Kalshi MVE Endpoints

Add `GET /events/multivariate` queries to both the universe ingestion and a new discovery script. MVEs may contain high-volume sports and political markets that are currently invisible.

**Files to modify:** `lib/ingestion/universe.mjs` (add MVE fetch loop), `lib/ingestion/sports-universe.mjs` (add MVE check)

#### 8.3 Increase `PMCI_POLITICS_MAX_EVENTS_PER_PROVIDER`

The default cap of 50 is too low. Kalshi has hundreds of political events across series like `KXSENATE*`, `KXGOVPARTY*`, `KXHOUSE*`. Increase to 500+ or remove the cap with proper rate limiting.

**File to modify:** `.env` configuration

### P1 — High Priority

#### 8.4 Bridge Universe Ingestion to Observer Loop

The observer reads `event_pairs.json` but universe ingestion writes to `pmci.provider_markets`. These are disconnected. Options:

- **Option A (recommended):** Make the observer read from `pmci.market_links` with `status='active'` instead of `event_pairs.json`. Each linked pair becomes a spread-tracked pair.
- **Option B:** Auto-generate `event_pairs.json` from accepted market links
- **Option C:** Merge observer and universe sweep into a single DB-driven loop

Option A is cleanest and aligns with the PMCI architecture, making the linker the source of truth for what gets tracked.

#### 8.5 Switch Polymarket to Cursor-Based Pagination

Replace offset-based pagination in `universe.mjs` with the [keyset pagination endpoint](https://docs.polymarket.com/api-reference/events/list-events-keyset-pagination):

```js
let afterCursor = null;
while (true) {
  const url = new URL(`${POLYMARKET_BASE}/events/keyset`);
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", "500");
  if (afterCursor) url.searchParams.set("after_cursor", afterCursor);
  const data = await fetchJson(url.toString());
  afterCursor = data?.next_cursor;
  if (!afterCursor) break;
}
```

**Files to modify:** `lib/ingestion/universe.mjs` (Polymarket section), `lib/ingestion/sports-universe.mjs`

#### 8.6 Add Kalshi `status=open` Filter to Universe Ingestion

The politics universe fetches events without a status filter, wasting API budget on settled events. Add `status=open` to the markets query.

**File to modify:** `lib/ingestion/universe.mjs:309-310` — add `marketsUrl.searchParams.set("status", "open")`

### P2 — Medium Priority

#### 8.7 Build Crypto Ingestion (Phase E2)

Per the roadmap, E2 crypto is next. Key implementation notes:
- Continuous price events (BTC > $X by date) vs binary yes/no
- Both Kalshi and Polymarket have active crypto markets
- Kalshi crypto series likely under a "Crypto" or "Finance" category
- Polymarket uses tags like `crypto`, `bitcoin`, `ethereum`
- Spread computation for non-binary markets is a new problem (design in E2 planning)

#### 8.8 Build Sports Cross-Platform Matching

The sports proposer exists but needs:
- A team name normalization table (abbreviation → full name, with league context)
- Game date alignment logic (within 1 day tolerance)
- Sport-specific entity parsing (team names, player names)
- Integration with the observer loop for real-time price tracking

#### 8.9 Normalize Price Comparison Across Platforms

Current code compares Kalshi ask/bid with Polymarket midpoint. For accurate spread detection:
- Use Polymarket CLOB API for live bid/ask when available
- Or normalize both to midpoint: `(bid + ask) / 2`
- Track which price source was used per snapshot (already partially implemented via `_pmci.price_source` metadata)

### P3 — Lower Priority

#### 8.10 Add `min_updated_ts` for Incremental Kalshi Ingestion

Instead of re-fetching all events, use Kalshi's `min_updated_ts` parameter to fetch only recently updated events. Reduces API calls and enables more frequent ingestion.

#### 8.11 Implement Rate-Limit-Aware Adaptive Backoff

Replace fixed delays (250ms, 300ms, 500ms) with adaptive backoff based on `Retry-After` headers and remaining rate budget.

#### 8.12 Add Coverage Gap Metrics

Track and expose:
- Markets on Kalshi not in PMCI (by category)
- Markets on Polymarket not in PMCI (by tag)
- Markets in PMCI but not cross-linked (by category)
- Markets cross-linked but not in observer loop
- Freshness of snapshots by category

---

## Appendix A: File Reference

| File | Purpose | Key Finding |
|------|---------|-------------|
| `observer.mjs` | Main observer loop | Reads only from `event_pairs.json` |
| `scripts/prediction_market_event_pairs.json` | Canonical event pairs config | 60 entries, all 2028 presidential nominees |
| `event_pairs.json` (root) | Legacy/duplicate config | Same content, observer uses scripts/ version |
| `lib/providers/kalshi.mjs` | Kalshi HTTP client | Fetches by event_ticker only, no discovery |
| `lib/providers/polymarket.mjs` | Polymarket HTTP client | Fetches by slug only, no discovery |
| `lib/ingestion/universe.mjs` | Politics universe ingestion | Hardcoded to politics via env vars + text filter |
| `lib/ingestion/sports-universe.mjs` | Sports universe ingestion | Category=Sports works, no cross-platform matching |
| `lib/ingestion/observer-cycle.mjs` | Observer cycle orchestration | Groups pairs by event, runs fetch+insert |
| `lib/ingestion/pmci-sweep.mjs` | Snapshot catch-up sweep | Only snapshots known markets, no discovery |
| `lib/matching/proposal-engine.mjs` | Cross-platform link proposer | Politics-only, 1200+ lines of matching logic |
| `lib/pmci-ingestion.mjs` | DB upsert helpers | Supports sports columns but no category-agnostic flow |
| `docs/roadmap.md` | Phase roadmap | E1 sports mostly done, E2 crypto planning |
| `docs/plans/phase-e1-sports-plan.md` | E1 detailed plan | Sports canonical event schema and guards |

## Appendix B: Key Environment Variables Affecting Coverage

| Variable | Default | Impact on Coverage |
|----------|---------|-------------------|
| `PMCI_POLITICS_KALSHI_SERIES_TICKERS` | (none) | Which Kalshi series to ingest for politics |
| `PMCI_POLITICS_POLY_TAG_ID` | (none) | Which Polymarket tag to ingest for politics |
| `PMCI_POLITICS_MAX_EVENTS_PER_PROVIDER` | `50` | **Caps events ingested per provider** |
| `PMCI_POLITICS_KALSHI_MAX_EVENTS` | `50` | Kalshi-specific event cap |
| `PMCI_POLITICS_REQUEST_DELAY_MS` | `250` | Delay between API requests |
| `PMCI_POLITICS_KALSHI_CONCURRENCY` | `1` | Parallel Kalshi event fetches |
| `PMCI_SWEEP_BATCH_LIMIT` | `600` | Max markets per sweep cycle |
| `SPREAD_EVENT_PAIRS_PATH` | `scripts/prediction_market_event_pairs.json` | Observer config path |

## Appendix C: Sources

- [Kalshi API — Get Events](https://docs.kalshi.com/api-reference/events/get-events)
- [Kalshi API — Get Markets](https://docs.kalshi.com/api-reference/market/get-markets)
- [Kalshi API — Get Series](https://docs.kalshi.com/api-reference/market/get-series-list)
- [Kalshi API — Tags by Categories](https://docs.kalshi.com/api-reference/search/get-tags-for-series-categories)
- [Kalshi API — Market Lifecycle](https://docs.kalshi.com/websockets/market-&-event-lifecycle)
- [Kalshi API — Pagination](https://docs.kalshi.com/getting_started/pagination)
- [Kalshi API — Rate Limits](https://docs.kalshi.com/getting_started/rate_limits)
- [Kalshi API — MVE Collections](https://docs.kalshi.com/api-reference/collection/get-multivariate-event-collections)
- [Kalshi API — Changelog](https://docs.kalshi.com/changelog)
- [Polymarket — Gamma API Overview](https://docs.polymarket.com/developers/gamma-markets-api/overview)
- [Polymarket — List Markets](https://docs.polymarket.com/api-reference/markets/list-markets)
- [Polymarket — Fetching Markets Guide](https://docs.polymarket.com/developers/gamma-markets-api/fetch-markets-guide)
- [Polymarket — Keyset Pagination](https://docs.polymarket.com/api-reference/events/list-events-keyset-pagination)
- [Polymarket — Sports Metadata](https://docs.polymarket.com/api-reference/sports/get-sports-metadata-information)
- [Polymarket — Event Tags](https://docs.polymarket.com/api-reference/events/get-event-tags)
- [Cross-Platform Arbitrage — PredictionMarketsPicks](https://predictionmarketspicks.com/articles/cross-platform-arbitrage-prediction-markets)
- [Cross-Platform Arb Scanner](https://predictionmarketspicks.com/tools/arb-scanner)
- [Polymarket Gamma API Guide — AgentBets](https://agentbets.ai/guides/polymarket-gamma-api-guide/)
- [Polymarket API Guide — pm.wiki](https://pm.wiki/learn/polymarket-api)
