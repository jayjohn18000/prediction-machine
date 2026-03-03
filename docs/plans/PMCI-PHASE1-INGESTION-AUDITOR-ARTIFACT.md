# INGESTION_AUDITOR artifact: Politics universe ingestion plan

**Agent:** INGESTION_AUDITOR  
**Goal:** Broaden politics ingestion to include non-paired (venue-unique) markets while keeping paired ingestion intact.  
**Scope:** ingestion → schemas → event_pairs → observer. No windows, calibration, scoring, or execution.

---

## 1) Current state (verified)

- **Paired-only ingestion:** The observer (`observer.mjs`) loads config from `scripts/prediction_market_event_pairs.json` (or `SPREAD_EVENT_PAIRS_PATH`). It groups pairs by `(eventTicker, slug)`, then for each group:
  - **Kalshi:** `GET {base}/markets?event_ticker={eventTicker}&limit=1000` → one request per event.
  - **Polymarket:** `GET {base}/events/slug/{slug}` (gamma-api.polymarket.com) → one request per event.
  - For each pair with valid prices, it calls `ingestPair()` in `lib/pmci-ingestion.mjs`, which upserts two rows into `pmci.provider_markets` (Kalshi + Polymarket) and appends snapshots.
- **Result:** `pmci.provider_markets` is populated only from those pairs (~122 markets total: 61 Kalshi + 61 Polymarket from event_pairs).
- **Config duality:** `event_pairs.json` (root) and `scripts/prediction_market_event_pairs.json` are effectively the same content; observer uses the script path by default; seed script tries both.

---

## 2) API endpoints / sources for broader politics (as used in current code)

| Provider     | Current use (paired) | Universe ingestion (new) |
|-------------|----------------------|----------------------------|
| **Kalshi**  | `GET /markets?event_ticker=X&limit=1000` (observer); `GET /events?event_ticker=X`, `GET /series/{series_ticker}`, `GET /markets?event_ticker=X` (lib/events-api.mjs) | **List events by series:** `GET /events?series_ticker=...&limit=200` (then for each event: `GET /markets?event_ticker=...`). Alternatively list series first via `GET /series` and filter by title/category for politics. |
| **Polymarket** | `GET /events/slug/{slug}` (observer) | **List events by tag:** `GET /events?tag_id={politics_tag_id}&active=true&closed=false&limit=...`. Discover tag: `GET /tags` or use known politics tag ID. |

- **Kalshi base:** `https://api.elections.kalshi.com/trade-api/v2` or `https://api.kalshi.com/trade-api/v2` (observer and lib use elections base).
- **Polymarket base:** `https://gamma-api.polymarket.com`.

---

## 3) Tagging category/subcategory and event_ref

- **category:** Set `category = 'politics'` for all markets ingested by the new universe path. (Existing paired ingestion already sets category from `pair.polymarketSlug`; for consistency we can also set category to `'politics'` for paired politics config, or leave paired as-is and only enforce politics for universe.)
- **subcategory:** No column today. Optional: store in `metadata` (e.g. `metadata->>'subcategory' = 'elections'`) or add a migration later; for Phase 1, `category = 'politics'` is enough.
- **event_ref (provider-native grouping):**
  - **Kalshi:** Set `event_ref = event_ticker` (e.g. `KXPRESNOMD-28`) so all markets in the same Kalshi event share the same `event_ref`.
  - **Polymarket:** Set `event_ref = event.slug` (e.g. `democratic-presidential-nominee-2028`) so all markets in the same Polymarket event share the same `event_ref`.
- **provider_market_ref:** Keep existing semantics: Kalshi = ticker; Polymarket = `{slug}#{outcomeName}` for outcome-level markets (or event-level slug if we ingest event-level first and then markets; see below).

---

## 4) Minimal changes to support universe ingestion (paired unchanged)

### A) New ingestion entrypoint (no change to observer loop)

- **Add a separate script:** e.g. `scripts/pmci-ingest-politics-universe.mjs`.
  - **Kalshi:** Fetch events (e.g. by `series_ticker` for politics/elections, or by listing series then events). For each event, fetch markets with existing-style API; for each market, upsert one row in `pmci.provider_markets` (provider_id=Kalshi, provider_market_ref=ticker, event_ref=event_ticker, title=..., category='politics', status from API), then append one snapshot if price data available.
  - **Polymarket:** Fetch events (e.g. `GET /events?tag_id=...&active=true&closed=false`). For each event, iterate markets; for each market/outcome, upsert one row (provider_market_ref = slug or `slug#questionId`/outcome as today), event_ref=event.slug, category='politics'), append snapshot.
  - Use the same `SQL_UPSERT_MARKET` and `SQL_INSERT_SNAPSHOT` from `lib/pmci-ingestion.mjs` so schema stays one place. Reuse `getProviderIds()` and DB client creation.

### B) Extend lib/pmci-ingestion.mjs (minimal)

- **Add:** `ingestKalshiMarket(client, providerId, marketRow, eventTicker, observedAt)` and `ingestPolymarketMarket(client, providerId, marketRow, eventSlug, observedAt)` that perform single-market upsert + one snapshot. Signature should accept normalized fields (provider_market_ref, title, category, event_ref, price_yes, bid, ask, liquidity, volume_24h, raw). This keeps observer and seed logic untouched; only the new script and (optionally) a future scheduler call these.
- **Do not remove or change:** `ingestPair()`, observer flow, or event_pairs config loading.

### C) Config / env

- **Optional:** `PMCI_POLITICS_SERIES_TICKER` (Kalshi) and `PMCI_POLITICS_TAG_ID` (Polymarket) for universe discovery; or hardcode initial politics series/tag in the script and document in README. Prefer env for flexibility.
- **No change** to `event_pairs.json` or `SPREAD_EVENT_PAIRS_PATH` for the paired flow.

### D) Definition of done (Phase 1 ingestion)

- [ ] `pmci.provider_markets` grows beyond the current 122 (paired) set after running the new universe ingestion script.
- [ ] `GET /v1/markets/new` and `GET /v1/markets/unlinked` with `category=politics` (or no category) show non-zero unlinked for at least one provider when there are politics markets that are not yet in any family.

---

## 5) PR plan: Politics universe ingestion

| Item | Detail |
|------|--------|
| **Title** | PMCI: broaden politics ingestion (universe) |
| **Files to touch** | |
| `lib/pmci-ingestion.mjs` | Add `ingestKalshiMarket`, `ingestPolymarketMarket` (single-market upsert + snapshot). Reuse existing SQL; no schema change. |
| `scripts/pmci-ingest-politics-universe.mjs` | **New.** Resolve provider IDs; fetch Kalshi events (by series or list), then markets per event; fetch Polymarket events (by tag_id), then markets per event; call new ingest helpers; log counts. |
| `README.md` or `.env.example` | Document optional `PMCI_POLITICS_SERIES_TICKER`, `PMCI_POLITICS_TAG_ID`; add `npm run pmci:ingest:universe` (or similar) that runs the new script. |
| `package.json` | Add script entry for universe ingestion (e.g. `"pmci:ingest:universe": "node scripts/pmci-ingest-politics-universe.mjs"`). |
| **Diff outline** | (1) Two new functions in pmci-ingestion.mjs calling existing SQL. (2) New script: load env, create client, getProviderIds, Kalshi loop (events → markets → ingest), Polymarket loop (events → markets → ingest), close client. (3) README/.env.example: one line each for env vars; one line for npm script. (4) package.json: one script line. |
| **Config/schema impact** | No change to event_pairs or PMCI schema. Existing `provider_markets.event_ref` and `category` used as above. |
| **Risks** | Rate limits on Kalshi/Polymarket if we crawl many events in one run; add a small delay per request if needed. Idempotent upserts; no backfill required for existing rows. |

---

## 6) Sanity checklist: Ingestion

- [ ] `event_pairs.json` / `scripts/prediction_market_event_pairs.json` remain valid; paired observer path unchanged.
- [ ] Observer still inserts one row per (candidate, cycle) per config and calls `ingestPair()` only for paired markets.
- [ ] No new columns without migration; `event_ref` and `category` already exist on `pmci.provider_markets`.
- [ ] New script uses DATABASE_URL; env vars (if any) documented in README or .env.example.
- [ ] After running universe script: `provider_markets` count increases; `/v1/markets/unlinked` and `/v1/markets/new` (with or without category=politics) can return non-zero where applicable.

---

## 7) Definition of done (for this agent)

- [x] Output is PR plan + sanity checklist.
- [x] Every suggested change is within ingestion/schema/observer/event_pairs scope.
- [x] No changes to window generation, calibration, scoring, or execution.
- [x] Human or Coordinator can hand this artifact to Cursor for implementation.
