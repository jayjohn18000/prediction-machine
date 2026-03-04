# PMCI Coverage & Unlinked — Agent Artifacts

## 1) RELATIONSHIP_MANAGER — Classification & schema alignment

### Non-overlap classification

- **Unlinked:** A `provider_market` is unlinked if its `id` is **not** present as `provider_market_id` in `pmci.v_market_links_current` (where `status = 'active'`). No dependency on `unmatched_markets` for the count/list; compute on-the-fly from `provider_markets` minus linked set.
- **Linked:** `provider_market_id` appears in `v_market_links_current` with status active.
- **unmatched_markets:** Table exists but is not populated by observer/linker. Use for future “reason” breakdown only; for v1, coverage/summary and unlinked lists use the “not in v_market_links_current” definition.

### Time filtering

- **first_seen_at,** **last_seen_at:** Both exist on `pmci.provider_markets` (default `now()`, upsert updates `last_seen_at`). Use for:
  - **since** (coverage/unlinked): filter `provider_markets` by `last_seen_at >= since` (or no filter if omitted).
  - **new markets:** filter by `first_seen_at >= since`, sort by `first_seen_at desc`.

### Schema alignment checklist

- [x] `provider_markets` has `first_seen_at`, `last_seen_at`, `category`, `status`, `url`.
- [x] Linked set = distinct `provider_market_id` from `pmci.v_market_links_current` (status <> 'removed').
- [x] No migration required for v1; unlinked derived from existing tables.

---

## 2) INGESTION_AUDITOR — Ingestion sanity

- **category:** Already set in observer ingestion: `eventRef` (= `pair.polymarketSlug`, e.g. `democratic-presidential-nominee-2028`).
- **status:** Set to `'open'` in upsert.
- **first_seen_at / last_seen_at:** Insert uses default `now()` for both; ON CONFLICT updates only `last_seen_at = now()`, so first_seen_at preserved. No change needed.
- **url:** Not set; optional. Smallest fix later: add `url` to upsert if provider API supplies it. Out of scope for v1.
- **Conclusion:** No ingestion code change required for coverage/unlinked endpoints.

---

## 3) REPORTER — Endpoint spec

### A) GET /v1/coverage/summary

- **Query:** `provider` (required), `category` (optional), `since` (optional, ISO or relative e.g. `24h`).
- **Response:** `{ provider, category, since, total_markets, linked_markets, unlinked_markets, coverage_ratio }`.
- **Logic:** Filter `provider_markets` by provider_id (from code), optional category, optional last_seen_at >= since. Linked = count distinct in v_market_links_current within that set. Unlinked = total - linked; coverage_ratio = linked/total (0 when total=0).

### B) GET /v1/markets/unlinked

- **Query:** `provider` (required), `category` (optional), `since` (optional), `limit` (optional, default 20, max 100).
- **Response:** Array of `{ provider, provider_market_id, provider_market_ref, title, category, status, first_seen_at, last_seen_at, url }`.
- **Sort:** `last_seen_at desc`, then `id desc` for stability.

### C) GET /v1/markets/new

- **Query:** `provider` (required), `category` (optional), `since` (required for “new” – ISO or relative), `limit` (optional, default 20, max 100).
- **Response:** Same shape as unlinked. Filter: `first_seen_at >= since`.
- **Sort:** `first_seen_at desc`, then `id desc`.

### Example curl

```bash
curl -s "http://localhost:8787/v1/coverage/summary?provider=kalshi"
curl -s "http://localhost:8787/v1/markets/unlinked?provider=kalshi&limit=10"
curl -s "http://localhost:8787/v1/markets/new?provider=kalshi&since=24h&limit=10"
```

---

## 4) VALIDATION_AGENT — Acceptance & script

- **Checks:** Endpoints return arrays where applicable with length <= limit; coverage/summary: linked + unlinked == total_markets for the filter scope; since filtering reduces counts when applied.
- **Script:** `scripts/check-coverage.mjs` (or `npm run pmci:check-coverage`): call summary, unlinked, new for provider=kalshi; verify summary totals consistent; exit 0/1.
- **Failure tree:** unknown_provider → bad code; empty total → no data or strict filter; linked+unlinked != total → bug in SQL.
