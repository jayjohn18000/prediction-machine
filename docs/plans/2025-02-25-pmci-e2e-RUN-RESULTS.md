# PMCI E2E Divergence — Full Agent Run Results

Single run of the orchestrated agent sequence. Commands were executed in-repo; API was not running for curl checks.

---

## 1. INGESTION_AUDITOR — Artifact

### Sanity checklist: Ingestion

- [x] **DATABASE_URL loaded in observer** — `observer.mjs` calls `loadEnv()` at startup (from repo root `.env`). `lib/pmci-ingestion.mjs` → `createPmciClient()` reads `process.env.DATABASE_URL`. When unset, client is null and PMCI is disabled. README documents DATABASE_URL.
- [ ] **provider_markets and snapshots increase over time** — **Not verified in this run.** `npm run pmci:smoke` reported `provider_markets: 0`, `snapshots: 0`. So either the observer has not been run with DATABASE_URL set, or it was run against a different DB. **User action:** Run `npm run start` with DATABASE_URL in `.env` for at least 1–2 cycles; expect log `PMCI ingestion: markets_upserted=… snapshots_appended=…`. Then re-run `npm run pmci:smoke` (must pass).
- [x] **DEM and GOP slugs present in config** — Observer default: `scripts/prediction_market_event_pairs.json`. Seeder falls back to `event_pairs.json`. Both exist; `prediction_market_event_pairs.json` has `democratic-presidential-nominee-2028` and `republican-presidential-nominee-2028`.
- [x] **provider_market_ref format** — Kalshi: ticker (e.g. `KXPRESNOMD-28-GN`). Polymarket: `polymarketSlug#polymarketOutcomeName` (e.g. `democratic-presidential-nominee-2028#Gavin Newsom`). Same format in `lib/pmci-ingestion.mjs` (ingestPair) and `scripts/seed-pmci-families-links.mjs` (SQL_GET_MARKET_ID). No mismatch.

### Concrete fix (if any)

**None.** Code and config are aligned. The only blocker to a passing smoke test is running the observer so that provider_markets and snapshots are populated.

---

## 2. RELATIONSHIP_MANAGER — Artifact

### Dependency map

- **Ingestion** (observer, pmci-ingestion) → consumed by: seed script (provider_markets), API (snapshots via market-links/divergence).
- **Seed** (seed-pmci-families-links) → writes: canonical_events, market_families, market_links; consumed by: API (families_by_event, current_links_for_family).
- **API** (src/api.mjs, queries.mjs) → consumed by: external / human (event_id UUID, family_id).

### Schema/API alignment checklist

- [x] **Canonical event UUID flow** — Seeder prints `slug => uuid` (e.g. `democratic-presidential-nominee-2028 => c8515a58-c984-46fe-ac65-25e362e68333`). API `GET /v1/market-families?event_id=<uuid>` expects UUID; `src/queries.mjs` uses `canonical_event_id = $1`. Aligned.
- [x] **Families use canonical_event_id** — Seed script sets `canonical_event_id` on insert/update of market_families. API queries `market_families` where `canonical_event_id = $1`. Aligned.
- [x] **Labels stable** — Seed uses `label = \`${eventId}::${candidate}\`` (event_id::candidate). No drift.
- [x] **market_links / v_market_links_current** — API uses `SQL.current_links_for_family` which reads from `pmci.v_market_links_current`; seeder writes to `pmci.market_links`. View is defined in migration; used consistently.

**Quick fixes:** None. Alignment confirmed.

---

## 3. VALIDATION_AGENT — Artifact

### Acceptance tests: Vertical slice

| Step | Command / action | Pass condition |
|------|-------------------|-----------------|
| 1 | Run observer 1 cycle with DATABASE_URL in `.env` | Startup log shows "PMCI ingestion enabled" and one line `PMCI ingestion: markets_upserted=… snapshots_appended=…` |
| 2 | `npm run pmci:smoke` | Exit 0; provider_markets > 0, snapshots > 0 |
| 3 | `npm run seed:pmci` | Exit 0; prints "Canonical events" with lines `slug => uuid`; report shows families_created or families_skipped > 0, links_inserted > 0 (if markets exist) |
| 4a | Start API: `npm run api:pmci` | Server listening (default port 8787) |
| 4b | `GET /v1/market-families?event_id=<printed_uuid>` | 200; JSON array; length > 0 after seed with data |
| 4c | Pick `family_id` from first family; `GET /v1/market-links?family_id=<id>` | 200; array length >= 2 (kalshi + polymarket) |
| 4d | `GET /v1/signals/divergence?family_id=<id>` | 200; array of divergence rows (or empty with clear “need more snapshots” if no snapshots) |

### SQL spot checks

```sql
-- After observer + seed (with data)
SELECT COUNT(*) FROM pmci.provider_markets;   -- > 0
SELECT COUNT(*) FROM pmci.provider_market_snapshots;  -- > 0
SELECT COUNT(*) FROM pmci.market_families WHERE canonical_event_id = '<event_uuid>';  -- > 0
SELECT COUNT(*) FROM pmci.v_market_links_current l WHERE l.family_id = <family_id>;  -- >= 2
```

### Failure reason taxonomy

| Code | Description | When |
|------|-------------|------|
| `no_pmci_data` | provider_markets == 0 | Observer not run with DATABASE_URL or DB empty |
| `smoke_fail` | pmci:smoke exits non-zero | DATABASE_URL missing or tables empty |
| `seed_no_families` | families_created + families_skipped == 0, pairs_skipped_missing_market > 0 | Seed ran before observer populated provider_markets |
| `api_event_no_families` | GET market-families returns [] | Valid UUID but no families for that event (seed skipped all pairs for missing markets) |
| `api_links_lt_2` | GET market-links returns < 2 | Family exists but links not seeded or view filtering |
| `divergence_empty` | GET signals/divergence returns [] | No snapshots for linked markets, or consensus null |

---

## 4. REPORTER — Artifact (Top Divergences spec)

### Report format: Top Divergences

- **Output:** Either (A) API `GET /v1/signals/top-divergences?event_id=<uuid>&limit=20` returning JSON, or (B) script `scripts/report-top-divergences.mjs` writing to stdout or file.
- **Schema (per row):**
  - `event_id` (uuid), `family_id` (int), `label` (string)
  - `consensus_price` (number | null)
  - `divergences`: array of `{ provider, provider_market_ref, price, divergence, relationship_type, confidence, last_snapshot_at, liquidity_proxy }`
  - Optional: `reasons` (from link), `link_version`
- **Sorting formula:** Rank by max per-family divergence (e.g. `max(link.divergence)`), then by family id. Descending so largest divergence first.
- **When produced:** On demand (API) or via `node scripts/report-top-divergences.mjs [--event-id=uuid] [--limit=20]`.

### Endpoint shape (if API)

- **Path:** `GET /v1/signals/top-divergences`
- **Query:** `event_id` (required, UUID), `limit` (optional, default 20, max 100).
- **Response:** `{ event_id, families: [ { family_id, label, consensus_price, divergences: [ ... ] } ] }` with families sorted by max divergence desc.

### Sanity checklist: Reporting

- [ ] All required metrics present (event_id, family_id, consensus_price, per-link divergence).
- [ ] Output valid JSON (or documented CSV if script).
- [ ] No PII or live keys in report.
- [ ] Documented in README or run-queries.

---

## 5. WINDOW_SURGEON + CALIBRATION_ENGINEER

**Deferred.** To run only after steps 1–4 are stable (smoke pass, seed creates families/links, API returns families and divergence). Output: PR plan + migration (if needed) + rerun evidence.

---

## Commands actually run (this session)

| Command | Result |
|---------|--------|
| `npm run pmci:smoke` | Exit 1 — provider_markets: 0, snapshots: 0 (DB empty for PMCI) |
| `npm run seed:pmci` | Exit 0 — canonical_events created; printed 2 slug=>uuid; families_created: 0, pairs_skipped_missing_market: 61 (no provider_markets) |
| `GET /v1/market-families?event_id=...` | Not run (API server not started); would return [] with current DB |

---

## Definition of done — status

- [ ] Run observer with DATABASE_URL → PMCI ingestion active — **Blocked:** run observer 1–2 cycles.
- [ ] `npm run pmci:smoke` PASS — **Failed this run** (0 markets).
- [x] `npm run seed:pmci` creates canonical_events + prints slug=>uuid — **Done** (2 events, 0 families/links until markets exist).
- [ ] GET market-families returns > 0 — **Requires** smoke pass then re-seed.
- [ ] GET market-links >= 2 — **Requires** same.
- [ ] GET signals/divergence returns list or “need more snapshots” — **Requires** same.
- [x] Top-divergence report/endpoint **spec** ready — **Done** (in REPORTER artifact above).

**Next step for you:** Run the observer with DATABASE_URL set for 1–2 cycles, then re-run `npm run pmci:smoke` and `npm run seed:pmci`. After that, start the API and hit the three endpoints with the printed UUID and a family_id to satisfy the full definition of done.
