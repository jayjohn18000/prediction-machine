# Prediction Machine — Repo Blocker Audit

**Audit date:** 2026-04-13
**Auditor:** Automated codebase analysis
**Scope:** Ingestion pipeline, event matching, sports blockers, schema, performance

---

## 1. Executive Summary

The prediction-machine codebase has a working politics ingestion and matching pipeline that produces spread/edge/duration metrics, but **sports ingestion and matching remain the primary execution-path blockers**. The sports universe ingestion (`lib/ingestion/sports-universe.mjs`) successfully fetches markets from both Kalshi and Polymarket, but the **matching/proposal engine is hardcoded to `category = 'politics'`** — sports markets get ingested into `pmci.provider_markets` but cannot flow through the proposal engine to become linked families with actionable spreads. Additionally, the observer loop (`observer.mjs`) is locked to a static JSON config of 31 political event pairs and has no mechanism to observe sports markets. The system's architecture is solid but narrowly specialized; broadening it to sports (and eventually crypto/economics) requires lifting political assumptions out of approximately 5–8 core modules.

---

## 2. Ingestion Pipeline Map

```
                                    ┌──────────────────────┐
                                    │  event_pairs.json    │ (31 political pairs)
                                    │  (static config)      │
                                    └─────────┬────────────┘
                                              │
                              ┌───────────────▼──────────────────┐
                              │         observer.mjs              │
                              │  (continuous loop, 60s interval)  │
                              └───────────────┬──────────────────┘
                                              │
                    ┌─────────────────────────▼──────────────────────────┐
                    │      lib/ingestion/observer-cycle.mjs              │
                    │  runObserverCycle() — spread writes + PMCI writes  │
                    └────┬─────────────┬───────────────────┬────────────┘
                         │             │                   │
              ┌──────────▼──┐  ┌───────▼──────┐  ┌────────▼───────────┐
              │ kalshi.mjs   │  │ polymarket.mjs│  │ pmci-ingestion.mjs │
              │ (prices)     │  │ (prices)      │  │ (upsert + snapshot)│
              └──────────────┘  └──────────────┘  └────────────────────┘
                                              │
                    ┌─────────────────────────▼──────────────────────────┐
                    │      lib/ingestion/pmci-sweep.mjs                  │
                    │  runPmciSweep() — snapshots for stale markets      │
                    └────────────────────────────────────────────────────┘

  ═══════════════════ Batch ingestion (manual invocation) ═══════════════════

  ┌────────────────────────────────┐    ┌──────────────────────────────────┐
  │ lib/ingestion/universe.mjs     │    │ lib/ingestion/sports-universe.mjs│
  │ (npm run pmci:ingest:politics) │    │ (npm run pmci:ingest:sports)     │
  │ Kalshi series + Poly tag_id    │    │ Kalshi category=Sports + Poly    │
  └───────────────┬────────────────┘    │ tags keyword-filtered            │
                  │                     └──────────────┬───────────────────┘
                  │                                    │
                  └────────────────┬───────────────────┘
                                   ▼
                    ┌──────────────────────────────┐
                    │ pmci.provider_markets         │
                    │ pmci.provider_market_snapshots│
                    └───────────────┬──────────────┘
                                    │
                    ┌───────────────▼─────────────────────────────┐
                    │ lib/matching/proposal-engine.mjs             │
                    │ runProposalEngine() — politics ONLY          │
                    │ Writes: pmci.proposed_links, market_links    │
                    └───────────────┬─────────────────────────────┘
                                    │
                    ┌───────────────▼──────────────────────────┐
                    │ scripts/review/pmci-propose-links-sports │
                    │ (separate, simpler proposer for sports)  │
                    └───────────────┬──────────────────────────┘
                                    │
                    ┌───────────────▼─────────────────────────┐
                    │ scripts/gate/pmci-gate-sports.mjs        │
                    │ (gate check — 5 criteria for go/no-go)   │
                    └──────────────────────────────────────────┘
```

**Key file paths:**

| Component | File | Purpose |
|-----------|------|---------|
| Observer entry | `observer.mjs` | Main continuous loop |
| Observer cycle | `lib/ingestion/observer-cycle.mjs` | Single cycle logic |
| Kalshi prices | `lib/providers/kalshi.mjs` | Fetch + normalize Kalshi prices |
| Polymarket prices | `lib/providers/polymarket.mjs` | Fetch + normalize Polymarket prices |
| PMCI upsert | `lib/pmci-ingestion.mjs` | Upsert markets + append snapshots |
| Politics universe | `lib/ingestion/universe.mjs` | Batch politics ingestion |
| Sports universe | `lib/ingestion/sports-universe.mjs` | Batch sports ingestion |
| PMCI sweep | `lib/ingestion/pmci-sweep.mjs` | Stale market price refresh |
| Proposal engine | `lib/matching/proposal-engine.mjs` | Politics cross-provider matching |
| Sports proposer | `scripts/review/pmci-propose-links-sports.mjs` | Sports cross-provider matching |
| Scoring math | `lib/matching/scoring.mjs` | Jaccard, cosine, bipartite matching |
| Entity parsing | `lib/matching/entity-parse.mjs` | Name normalization for matching |
| Sports helpers | `lib/matching/sports-helpers.mjs` | Team name normalization, matchup keys |
| Sport inference | `lib/ingestion/services/sport-inference.mjs` | Sport code from ticker/tags |
| Price parsers | `lib/ingestion/services/price-parsers.mjs` | Outcome price extraction |
| Matching adapters | `lib/pmci-matching-adapters.mjs` | Template classification |
| Embeddings | `lib/embeddings.mjs` | OpenAI title embeddings |
| Retry/timeout | `lib/retry.mjs` | Exponential backoff + fetch timeout |
| Kalshi adapter | `lib/providers/kalshi-adapter.mjs` | Kalshi → canonical event mapping |
| Polymarket adapter | `lib/providers/polymarket-adapter.mjs` | Polymarket → canonical event mapping |

---

## 3. Prioritized Blocker List

### P0 — Execution-path blockers (preventing money)

#### P0-1: Proposal engine hardcoded to `category = 'politics'`

- **File:** `lib/matching/proposal-engine.mjs`, line 43
- **Evidence:** `const CATEGORY = 'politics';` — the entire proposal engine (1233 lines) filters all queries by this constant. Every DB query uses `WHERE category = $2` with this value. The topic-signature system (`TOPIC_KEY_PATTERNS`, `extractTopicSignature`, `extractTopicKey`) is entirely politics-specific (senate, governor, presidential nominee, etc.).
- **What it blocks:** Sports markets get ingested but can never become linked families through the main engine. The separate `scripts/review/pmci-propose-links-sports.mjs` exists as a workaround but lacks the sophistication of the politics engine (no embeddings, no bipartite matching, no confidence calibration, no auto-accept).
- **Recommended fix:** Extract a category-agnostic `ProposalEngine` base with pluggable blocking/scoring strategies. Implement a `SportsProposalStrategy` using `sports-helpers.mjs` logic (matchup key, sport, game_date, team normalization). Wire into the same DB write path with auto-accept for high-confidence sports matches (matchup_key + sport + game_date within 1 day = equivalent).
- **Effort:** 12–16 hours

#### P0-2: Observer loop locked to static JSON config — no sports observation

- **File:** `observer.mjs`, lines 34–64
- **Evidence:** `loadConfig()` reads `scripts/prediction_market_event_pairs.json` which contains exactly 31 hardcoded political event pairs (Democratic/Republican nominees). The config schema requires `kalshiTicker`, `polymarketSlug`, `polymarketOutcomeName` — a format that makes sense for nominee-style multi-outcome events but not for sports matchup markets.
- **What it blocks:** Sports markets are only observed via batch `npm run pmci:ingest:sports`, not the continuous observer. There's no real-time sports price tracking, so no live spreads or edge signals for sports.
- **Recommended fix:** Add a DB-driven observation path: after the static-pair cycle, query `pmci.provider_markets` for linked sports families and fetch fresh prices. This is partially implemented in `pmci-sweep.mjs` but sweep only writes snapshots, not `prediction_market_spreads` rows. Extend sweep to produce spread rows for linked sports families.
- **Effort:** 8–10 hours

#### P0-3: Sports proposer is a thin script with no auto-accept or family creation

- **File:** `scripts/review/pmci-propose-links-sports.mjs`, lines 1–182
- **Evidence:** The sports proposer writes `proposed_links` rows but never creates `market_families` or `market_links`. It writes proposals with `confidence = 0.96` for matchup-key matches but has no auto-accept logic. Every sports link requires manual review via `pmci:review` CLI. The pipeline is: ingest → propose → (manual review) → accept → gate check → ... This manual step blocks scaling.
- **What it blocks:** Even after sports ingestion succeeds, there's no automated path from proposed link to active family → spread computation → execution signal.
- **Recommended fix:** Add auto-accept logic for sports proposals where `confidence >= 0.95` AND `matchup_key` matches AND `date_delta_days <= 1` AND `sport` matches. Create families and links directly, mirroring the politics auto-accept in `proposal-engine.mjs` lines 908–963.
- **Effort:** 4–6 hours

#### P0-4: No sports spread/signal computation

- **Files:** `src/services/signal-queries.mjs`, `src/routes/signals.mjs`
- **Evidence:** The signal computation pipeline reads from `prediction_market_spreads` table (populated only by the observer loop for political pairs) or from `pmci.v_market_links_current`. Sports markets may appear in the latter but never in the former. The API routes serve signal data but there's no sports-specific signal endpoint.
- **What it blocks:** Even if sports markets were linked, there's no execution-layer signal pipeline producing actionable spread/edge/duration metrics for sports.
- **Recommended fix:** Extend the PMCI sweep or add a sports-specific cycle that, for each linked sports family, computes Kalshi-vs-Polymarket spread and writes to either `prediction_market_spreads` or a new sports-specific signals table.
- **Effort:** 6–8 hours

---

### P1 — Significant blockers reducing throughput or reliability

#### P1-1: Sports team name normalization is brittle — regex-only `parseTeams()`

- **File:** `lib/ingestion/sports-universe.mjs`, lines 140–151
- **Evidence:** `parseTeams()` uses a single regex: `/^(.+?)\s+(?:vs\.?|@|at(?!\s+(?:least|most|...)))\s+(.+?)(?:\s*[:\-\(]|$)/i`. This handles "Team A vs Team B" and "Team A @ Team B" but misses formats like "Team A - Team B", "Team A v Team B", "Team A/Team B", and multi-line titles. The negative lookahead for "at least/most" was added as a fix (E1.5) but the regex fundamentally can't handle variant title formats from different providers.
- **What it blocks:** `home_team` and `away_team` fields are null for many markets → `matchupKey` is 'unknown' → sports proposer skips them entirely (line 63: `if (!ks.isMatchup || ks.matchupKey === 'unknown') continue;`).
- **Recommended fix:** Build a proper `parseTeams()` that handles multiple separator patterns and normalizes team name variants. Add a team alias dictionary for major leagues (e.g., "LAL" = "Los Angeles Lakers", "MAN UTD" = "Manchester United").
- **Effort:** 4–6 hours

#### P1-2: Polymarket sport inference falls back to 'unknown' for numeric tag IDs

- **File:** `lib/ingestion/services/sport-inference.mjs`, lines 214–253
- **Evidence:** `inferSportFromPolymarketTags()` matches against `POLYMARKET_TAG_MAP` which uses string substrings like `'nfl'`, `'soccer'`, `'tennis'`. But Polymarket tag IDs from the `/sports` endpoint are numeric strings like `"5"`, `"155"`. These never match the substring map. The fallback to `inferSportFromKalshiTicker(title)` at `sports-universe.mjs` line 378–379 helps but is imprecise for Polymarket-specific title formats.
- **What it blocks:** Many Polymarket sports markets get `sport = 'unknown'` → filtered out by sports proposer (line 31: `and sport <> 'unknown'`).
- **Recommended fix:** In `fetchPolymarketSportsTags()`, map the `/sports` endpoint response to canonical sport codes using the returned sport labels (not tag IDs). Persist the mapping and use it during ingestion. The `/sports` endpoint already returns `sport` labels — thread them through.
- **Effort:** 3–4 hours

#### P1-3: Sports ingestion processes all series sequentially with fixed 100-300ms delays

- **File:** `lib/ingestion/sports-universe.mjs`, lines 157–257 (Kalshi), 342–437 (Polymarket)
- **Evidence:** Kalshi sports ingestion loops through every sports series one at a time (line 182: `for (const { ticker, ... } of sportSeries)`), then every event (line 193: `while (true)`), then every market — all sequential with `await sleep(100-300)` between requests. With 100+ sports series and hundreds of events each, a full ingestion run takes 30+ minutes.
- **What it blocks:** Stale prices. By the time a full sports run completes, early-ingested prices are 30+ minutes old. Sports markets can move in seconds.
- **Recommended fix:** Add bounded concurrency (e.g., 5 parallel series fetches for Kalshi, 10 parallel tag fetches for Polymarket). Use a semaphore pattern. The politics universe already has `PMCI_POLITICS_KALSHI_CONCURRENCY` but sports doesn't.
- **Effort:** 3–4 hours

#### P1-4: No Polymarket `bestBidYes` / `bestAskYes` in sports ingestion

- **File:** `lib/ingestion/sports-universe.mjs`, lines 410–428
- **Evidence:** The Polymarket sports ingestion writes `priceYes` from `outcomePrices` but does not extract `bestBidYes` or `bestAskYes` from the market response. Compare to the politics universe (`lib/ingestion/universe.mjs`, line 615) which at least attempts to pass `bestBidYes: null, bestAskYes: null` explicitly. Without bid/ask, spread computation is limited to midpoint only — no executable edge.
- **What it blocks:** Sports execution signals need bid/ask to compute actionable spreads. Midpoint-only signals overestimate edge and create phantom arbitrage.
- **Recommended fix:** Parse `bestBid` and `bestAsk` from the Polymarket `/markets` response (they're present in the Gamma API payload). Add to `ingestProviderMarket()` call.
- **Effort:** 1–2 hours

#### P1-5: PMCI sweep status filter misses sports markets

- **File:** `lib/ingestion/pmci-sweep.mjs`, lines 11–23
- **Evidence:** `SQL_STALE_MARKETS` filters `WHERE (pm.status IS NULL OR pm.status = 'open')`. But sports markets from Kalshi are ingested with `status = 'active'` (not 'open') per `sports-universe.mjs` line 218, and Polymarket sports use `status = 'active'` per line 419. This means the sweep never picks up sports markets for price refresh.
- **What it blocks:** Sports market prices go stale between batch ingestion runs because the continuous sweep ignores them.
- **Recommended fix:** Change sweep filter to `WHERE (pm.status IS NULL OR pm.status IN ('open', 'active'))`.
- **Effort:** 0.5 hours

#### P1-6: Embedding generation creates N+1 API calls during ingestion

- **File:** `lib/pmci-ingestion.mjs`, lines 171–189 and 225–257
- **Evidence:** `ingestProviderMarket()` calls `ensureTitleEmbedding()` for every single market upsert. This makes an OpenAI API call per market (unless the embedding already exists). During a universe ingestion of 500+ markets, this adds significant latency and cost. The `embeddings.mjs` has an in-process cache but it's process-scoped (lost between runs) and doesn't batch.
- **What it blocks:** Slow ingestion throughput. Each embedding call adds ~200ms network latency per market.
- **Recommended fix:** Batch embedding generation. Collect all new titles after the upsert phase, call `embedBatch()` once, then update all rows in a single query. The `embedBatch()` function already exists in `lib/embeddings.mjs` but is unused by the ingestion path.
- **Effort:** 3–4 hours

---

### P2 — Lower priority issues (reliability, data quality)

#### P2-1: No pagination for Kalshi `/markets` in observer cycle

- **File:** `lib/providers/kalshi.mjs`, line 22–23
- **Evidence:** `fetchAllKalshiPrices()` fetches with `limit=1000` but does not handle pagination cursors. If an event has >1000 markets (unlikely but possible for multi-outcome events), markets are silently dropped.
- **Recommended fix:** Add cursor-based pagination loop.
- **Effort:** 1 hour

#### P2-2: Polymarket price parsing assumes `outcomePrices[0]` is always YES

- **File:** `lib/providers/polymarket.mjs`, lines 51–53
- **Evidence:** `buildPolymarketPriceMap()` takes `outcomePricesArr[0]` as the YES price without checking the `outcomes` array order. If Polymarket returns `["No", "Yes"]`, the price is inverted.
- **Recommended fix:** Check `outcomes` array to find the YES index before extracting price.
- **Effort:** 1 hour

#### P2-3: Retry logic in observer providers is minimal (2 attempts)

- **File:** `lib/providers/kalshi.mjs`, line 26; `lib/providers/polymarket.mjs`, line 20
- **Evidence:** Both use `retry(fn, { maxAttempts: 2, baseDelayMs: 800 })`. For a production system that runs 24/7, 2 attempts with 800ms base delay is aggressive. Transient network issues or brief API outages will cause missed cycles.
- **Recommended fix:** Increase to `maxAttempts: 4`, add exponential backoff with jitter (already supported by `retry.mjs`).
- **Effort:** 0.5 hours

#### P2-4: Snapshot table unbounded growth (mitigated but not for all tiers)

- **File:** `supabase/migrations/20260331000002_snapshot_retention.sql`
- **Evidence:** Snapshot retention uses `pg_cron` to delete rows >30 days old. But `pg_cron` requires Supabase Pro plan. On free tier, `provider_market_snapshots` grows unbounded.
- **Recommended fix:** Add an application-level retention sweep as a fallback (run from a script or in the observer cycle).
- **Effort:** 2 hours

#### P2-5: `event_type` hardcoded to `'game_result'` for all sports markets

- **File:** `lib/ingestion/sports-universe.mjs`, lines 237 and 416
- **Evidence:** Both Kalshi and Polymarket sports ingestion set `eventType: "game_result"` for every market. Player props, season awards, draft picks, and championship futures all get the wrong type.
- **Recommended fix:** Implement title-based inference for `event_type` using patterns (e.g., "MVP" → `season_award`, "draft" → `draft_pick`, "over/under" → `player_prop`).
- **Effort:** 2–3 hours

#### P2-6: No test coverage for critical matching logic

- **File:** `test/matching/` directory exists but contents unclear
- **Evidence:** No test runner configured in `package.json` (no `test` script). The `test/` directory has test files (`dual-listings.test.mjs`, `kalshi-adapter.test.mjs`, etc.) but no test framework dependency (no vitest, jest, or mocha in `package.json`).
- **What it blocks:** Refactoring the proposal engine or scoring logic is risky without tests.
- **Recommended fix:** Add vitest, write unit tests for `scoring.mjs`, `entity-parse.mjs`, `sports-helpers.mjs`, and `sport-inference.mjs`.
- **Effort:** 4–6 hours

---

## 4. Sports Ingestion Gap Analysis

### What works

1. **Sports universe ingestion** (`lib/ingestion/sports-universe.mjs`) successfully fetches:
   - All Kalshi series with `category === 'Sports'` (~100+ series)
   - Polymarket markets via `/sports` endpoint or tag keyword fallback
2. **Sport inference** (`lib/ingestion/services/sport-inference.mjs`) has extensive pattern matching for 40+ sport codes across both providers.
3. **Sports schema** exists: `sport`, `event_type`, `game_date`, `home_team`, `away_team` columns added via migration `20260331000001_sports_market_fields.sql`.
4. **Sports matching helpers** (`lib/matching/sports-helpers.mjs`) implement team normalization, matchup key generation, date delta checking, and market-type bucket classification.
5. **Sports proposer** (`scripts/review/pmci-propose-links-sports.mjs`) generates proposals with semantic validation.
6. **Sports gate** (`scripts/gate/pmci-gate-sports.mjs`) verifies 5 criteria before sports phase completion.

### What's missing or broken

| Gap | Impact | Location |
|-----|--------|----------|
| **No auto-accept for sports proposals** | Every link requires manual review | `scripts/review/pmci-propose-links-sports.mjs` — writes proposals only, no `market_links` creation |
| **No continuous sports observation** | Sports prices go stale between batch runs | `observer.mjs` — locked to static political pairs config |
| **PMCI sweep ignores `status='active'`** | Sports markets never refreshed by sweep | `lib/ingestion/pmci-sweep.mjs` line 16 |
| **Polymarket sport inference returns 'unknown' for numeric tags** | Markets filtered out of proposer | `lib/ingestion/services/sport-inference.mjs` line 217 |
| **`parseTeams()` regex misses many formats** | `matchupKey = 'unknown'` → dropped by proposer | `lib/ingestion/sports-universe.mjs` line 144 |
| **No bid/ask for Polymarket sports markets** | Cannot compute executable spread | `lib/ingestion/sports-universe.mjs` line 410 |
| **`event_type` always 'game_result'** | Misclassifies props, futures, awards | `lib/ingestion/sports-universe.mjs` lines 237, 416 |
| **No sports signal/spread computation** | No execution-layer output for sports | Missing entirely — no sports-specific signal pipeline |
| **Sequential ingestion — no concurrency** | 30+ minute full sports ingestion run | `lib/ingestion/sports-universe.mjs` — single-threaded loops |
| **No sports-aware proposal engine** | Sports matching lacks embeddings, bipartite matching | `lib/matching/proposal-engine.mjs` only supports politics |

### End-to-end sports flow status

```
[✅] Kalshi sports series discovery
[✅] Polymarket sports tag discovery
[✅] Sports market ingestion → pmci.provider_markets
[✅] Sport code inference (mostly works, some gaps)
[⚠️] Team name extraction (regex-only, many misses)
[⚠️] Sports proposal generation (works but no auto-accept)
[❌] Sports link creation (requires manual review)
[❌] Sports family → spread computation (not implemented)
[❌] Continuous sports price observation (not implemented)
[❌] Sports execution signals (not implemented)
```

---

## 5. Schema / Data Model Issues

### 5.1 Status field inconsistency

- **`pmci.provider_markets.status`** has no enum constraint — it's `text`. Different ingestion paths write different values:
  - Observer: `'open'` (`lib/pmci-ingestion.mjs` line 286)
  - Politics universe: `'open'` or null (from Kalshi `m?.status`)
  - Sports universe Kalshi: raw status like `'active'` (`sports-universe.mjs` line 234)
  - Sports universe Polymarket: `'active'` or `'closed'` (`sports-universe.mjs` line 419)
  - PMCI sweep filter: only `'open'` or NULL (`pmci-sweep.mjs` line 16)
- **Impact:** Sweep misses `'active'` markets; queries filtering by status are inconsistent.
- **Fix:** Normalize to a consistent set (`open`, `closed`, `settled`) at write time.

### 5.2 Missing `liquidity` / `volume_24h` for observer-pair Polymarket snapshots

- **File:** `lib/pmci-ingestion.mjs`, lines 328–333
- **Evidence:** `ingestPair()` writes Polymarket snapshots with `liquidity: null, volume24h: null` because the observer's Polymarket fetcher doesn't extract these fields.
- **Impact:** Execution signals can't assess market depth for observer-tracked markets.

### 5.3 `event_type` CHECK constraint too restrictive

- **File:** `supabase/migrations/20260331000001_sports_market_fields.sql`, line 6
- **Evidence:** `CHECK (event_type IN ('game_result','season_award','draft_pick','player_prop','championship','unknown'))`. This will reject any future event types. A more flexible approach would be to use an enum or remove the CHECK.
- **Impact:** Low — but adding new event types requires a migration.

### 5.4 `provider_market_ref` format differs between observer and universe paths

- Observer creates Polymarket refs as `slug#CandidateName` (e.g., `democratic-presidential-nominee-2028#Gavin Newsom`)
- Universe creates refs as `slug#outcomeName` (same format but different naming convention — sometimes numeric condition IDs)
- Sports universe uses raw `conditionId` as ref (e.g., `0x8a7b...`)
- **Impact:** Sweep's `extractOutcomeName()` and `findPolymarketMatch()` may fail for non-standard ref formats.

### 5.5 No `category` index on `proposed_links`

- **File:** `supabase/migrations/20260301000001_pmci_proposals.sql`
- **Evidence:** The proposals table is queried with `WHERE category = 'sports'` and `WHERE category = 'politics'` but there's no index on `category`.
- **Impact:** As proposals grow, these queries slow down.

---

## 6. "Fix Now" Shortlist

These three changes would unblock the sports execution layer fastest, ordered by impact-per-hour:

### Fix 1: PMCI sweep status filter (0.5 hours, unblocks price freshness)

**File:** `lib/ingestion/pmci-sweep.mjs`, line 16

Change:
```sql
WHERE (pm.status IS NULL OR pm.status = 'open')
```
To:
```sql
WHERE (pm.status IS NULL OR pm.status IN ('open', 'active'))
```

This immediately enables the continuous observer to refresh sports market prices via sweep, without any changes to the observer loop itself.

### Fix 2: Sports auto-accept for high-confidence matches (4–6 hours, unblocks linking)

**File:** `scripts/review/pmci-propose-links-sports.mjs`

Add auto-accept logic after line 164 (the `client.query` insert):
- When `confidence >= 0.95` AND both markets have matching `sport` + `matchupKey` + `game_date` within 1 day:
  - Create a `pmci.market_families` row
  - Create two `pmci.market_links` rows (one per provider)
  - Write the proposal with `decision = 'accepted'`
- This mirrors the politics auto-accept pattern from `proposal-engine.mjs` lines 908–963.

### Fix 3: Add Polymarket `bestBid`/`bestAsk` to sports ingestion (1–2 hours, unblocks executable edge)

**File:** `lib/ingestion/sports-universe.mjs`, line 410

The Gamma API response includes `bestBid` and `bestAsk` fields. Parse and pass them through:
```javascript
bestBidYes: parseNum(m?.bestBid) ?? null,
bestAskYes: parseNum(m?.bestAsk) ?? null,
```

This enables real spread computation (not just midpoint) for sports markets once they're linked.

---

## 7. Dependency Map

```
observer.mjs
  ├── src/platform/env.mjs
  ├── lib/pmci-ingestion.mjs
  │     ├── src/platform/db.mjs (pg Client)
  │     └── lib/embeddings.mjs (OpenAI API)
  └── lib/ingestion/observer-cycle.mjs
        ├── lib/providers/kalshi.mjs
        │     └── lib/retry.mjs
        ├── lib/providers/polymarket.mjs
        │     └── lib/retry.mjs
        ├── lib/pmci-ingestion.mjs
        └── lib/ingestion/pmci-sweep.mjs
              ├── lib/providers/kalshi.mjs
              ├── lib/providers/polymarket.mjs
              └── lib/pmci-ingestion.mjs

lib/ingestion/universe.mjs (politics batch)
  ├── lib/pmci-ingestion.mjs
  ├── lib/ingestion/services/price-parsers.mjs
  └── lib/ingestion/services/market-metadata.mjs

lib/ingestion/sports-universe.mjs (sports batch)
  ├── lib/pmci-ingestion.mjs
  ├── lib/ingestion/services/price-parsers.mjs
  └── lib/ingestion/services/sport-inference.mjs

lib/matching/proposal-engine.mjs (politics matching)
  ├── lib/pmci-matching-adapters.mjs
  ├── lib/matching/scoring.mjs
  └── lib/matching/entity-parse.mjs
        └── lib/matching/scoring.mjs

scripts/review/pmci-propose-links-sports.mjs (sports matching)
  └── lib/matching/sports-helpers.mjs
        └── lib/matching/scoring.mjs

src/api.mjs (PMCI API)
  └── src/server.mjs
        ├── src/routes/health.mjs
        ├── src/routes/markets.mjs
        ├── src/routes/families.mjs
        ├── src/routes/links.mjs
        ├── src/routes/signals.mjs
        ├── src/routes/coverage.mjs
        └── src/routes/review.mjs
              └── src/services/* (various service modules)
```

### Critical shared dependencies

| Module | Used by | Risk if broken |
|--------|---------|----------------|
| `lib/pmci-ingestion.mjs` | observer, universe, sports-universe, sweep | All ingestion stops |
| `src/platform/db.mjs` | All DB-connected modules | Total system failure |
| `lib/retry.mjs` | kalshi.mjs, polymarket.mjs | Provider fetches fail silently |
| `lib/ingestion/services/price-parsers.mjs` | universe, sports-universe | Price data corrupt |
| `lib/matching/scoring.mjs` | proposal-engine, sports proposer | Matching quality degrades |

---

## Appendix: Additional Observations

### A. Crypto/Economics categories not built

- `lib/providers/kalshi-adapter.mjs` has `inferCategory()` with crypto/weather stubs (line 39–46) but no ingestion pipeline exists.
- The CLAUDE.md says "Current active phase: Phase E2 — crypto expansion (E1.5 complete 2026-04-10)" but no crypto files exist in the repo.
- This is expected per the task context but worth noting: the adapter layer needs the same category-agnostic treatment as sports.

### B. `isLikelyPoliticsText()` filter in universe.mjs silently drops markets

- **File:** `lib/ingestion/universe.mjs`, lines 47–49 and 336, 588, 659
- The politics universe ingestion calls `isLikelyPoliticsText()` which rejects any market whose title doesn't contain political keywords. This is appropriate for the politics pipeline but means any mixed-category series (e.g., Kalshi series that contains both political and policy/economic markets) will silently drop non-political markets.

### C. Lock file approach in sports ingestion

- **File:** `lib/ingestion/sports-universe.mjs`, lines 27–47
- Uses `/tmp/pmci-sports-ingest.lock` file with PID check. This is fragile across system restarts and doesn't work across containers or multiple hosts. For production, consider database-level advisory locks.

### D. No structured logging

- All logging uses `console.log`/`console.error`/`console.warn` with ad-hoc string formatting.
- No log levels, no structured JSON output, no correlation IDs.
- Makes production debugging difficult, especially when observer, sweep, and batch ingestion produce interleaved output.
