# PMCI API Reference

**Base URL:** `http://localhost:8787` (dev) · `https://<PMCI_HOST>` (prod)
**API Version:** `2026-03-02` — present as `X-PMCI-Version` header on every response.
**Spec:** [`docs/openapi.yaml`](./openapi.yaml)

---

## Auth Tiers

| Tier     | Header             | When required                                    |
|----------|--------------------|--------------------------------------------------|
| Public   | —                  | `/v1/health/*` — always open                     |
| Standard | `x-pmci-api-key`   | All other routes when `PMCI_API_KEY` env is set  |
| Admin    | `x-pmci-admin-key` | `POST /v1/resolve/link` when `PMCI_ADMIN_KEY` set|

When neither env var is set the API is fully open (useful for local dev).

**Rate limit:** 60 requests / 60 s per key (or IP). Configurable via `PMCI_RATE_LIMIT_MAX` and `PMCI_RATE_LIMIT_WINDOW_MS`.

---

## Route Cheatsheet

| Method | Path                         | Auth     | Required params              | Notes                                  |
|--------|------------------------------|----------|------------------------------|----------------------------------------|
| GET    | `/v1/health/freshness`       | Public   | —                            | Liveness check; live `lag_seconds` / `staleness_seconds`, `latest_snapshot_at` computed from snapshots |
| GET    | `/v1/health/slo`             | Public   | —                            | 4-check SLO report                     |
| GET    | `/v1/health/projection-ready`| Public   | —                            | `ready` bool + `missing_steps[]`       |
| GET    | `/v1/health/observer`        | Public   | `provider`=`kalshi`|`polymarket` (optional drilldown via `provider_focus`) | `true_success_rate` Σ-window alert (`alert`/`failure_rate`), `configured_pair_success_rate`, error totals |
| GET    | `/v1/health/usage`           | Public   | —                            | Per-endpoint stats, last 24h           |
| GET    | `/v1/providers`              | Standard | —                            | `[{code, name}]`                       |
| GET    | `/v1/coverage`               | Standard | `provider`                   | `coverage_ratio`, unmatched breakdown  |
| GET    | `/v1/coverage/summary`       | Standard | `provider`                   | linked vs unlinked counts              |
| GET    | `/v1/markets/unlinked`       | Standard | `provider`                   | Markets with no family link            |
| GET    | `/v1/markets/new`            | Standard | `provider`, `since`          | Markets first seen after `since`       |
| GET    | `/v1/canonical-events`       | Standard | —                            | List canonical events; filter by `category` |
| GET    | `/v1/market-families`        | Standard | `event_id` (UUID)            | Families under a canonical event       |
| GET    | `/v1/market-links`           | Standard | `family_id` (int)            | Links in a family with price/divergence|
| GET    | `/v1/links`                  | Standard | —                            | Historical/current links with filters  |
| GET    | `/v1/signals/divergence`     | Standard | `family_id` (int)            | **503 if stale.** Per-link divergence  |
| GET    | `/v1/signals/top-divergences`| Standard | `event_id` (UUID)            | **503 if stale.** Top divergences      |
| GET    | `/v1/review/queue`           | Standard | —                            | Pending proposals above confidence     |
| POST   | `/v1/review/decision`        | Standard | body (see below)             | Accept / reject / skip a proposal      |
| POST   | `/v1/resolve/link`           | Admin    | body (see below)             | Directly insert an active link         |

---

## Parameter Reference

### Common: `provider`, `category`, `since`, `limit`

| Param      | Type            | Required    | Notes                                               |
|------------|-----------------|-------------|-----------------------------------------------------|
| `provider` | string          | Yes (most)  | `"kalshi"` or `"polymarket"`                        |
| `category` | string          | No          | e.g. `"politics"`                                   |
| `since`    | string          | See route   | ISO 8601 **or** relative shorthand (`"24h"`, `"7d"`)|
| `limit`    | integer (1–100) | No          | Default 20                                          |

`since` is **required** on `/v1/markets/new`, optional on `/v1/markets/unlinked` and `/v1/coverage/summary`.

### `/v1/links`

| Param    | Type               | Default   | Notes |
|----------|--------------------|-----------|-------|
| `status` | `active\|removed\|any` | `active` | Use `any` to include removed links/history |
| `topic`  | string             | —         | Category filter (e.g. `politics`) |
| `after`  | ISO 8601 datetime  | —         | Filters on `created_at >= after` |
| `limit`  | integer 1–200      | `50`      | Page size |
| `offset` | integer >=0        | `0`       | Pagination offset |

### `/v1/review/queue`

| Param            | Type          | Default     |
|------------------|---------------|-------------|
| `category`       | string        | `"politics"`|
| `limit`          | integer 1–100 | `1`         |
| `min_confidence` | number 0–1    | `0.88`      |

### `POST /v1/review/decision` — request body

```json
{
  "proposed_id": 42,
  "decision": "accept",
  "relationship_type": "equivalent",
  "note": "optional reviewer note"
}
```

| Field               | Type                              | Required |
|---------------------|-----------------------------------|----------|
| `proposed_id`       | integer                           | Yes      |
| `decision`          | `"accept"` \| `"reject"` \| `"skip"` | Yes  |
| `relationship_type` | `"equivalent"` \| `"proxy"`      | Yes      |
| `note`              | string                            | No       |

### `POST /v1/resolve/link` — request body (Admin)

```json
{
  "family_id": 12,
  "provider_code": "kalshi",
  "provider_market_id": 999,
  "relationship_type": "equivalent",
  "confidence": 0.95,
  "reasons": { "source": "manual" },
  "correlation_window": null,
  "lag_seconds": null,
  "correlation_strength": null
}
```

| Field                 | Type                                              | Required |
|-----------------------|---------------------------------------------------|----------|
| `family_id`           | integer                                           | Yes      |
| `provider_code`       | `"kalshi"` \| `"polymarket"`                      | Yes      |
| `provider_market_id`  | integer                                           | Yes      |
| `relationship_type`   | `"identical"` \| `"equivalent"` \| `"proxy"` \| `"correlated"` | Yes |
| `confidence`          | number (0–1)                                      | Yes      |
| `reasons`             | object (open-ended)                               | Yes      |
| `correlation_window`  | string                                            | No       |
| `lag_seconds`         | integer                                           | No       |
| `correlation_strength`| number (−1 to 1)                                  | No       |

---

## Usage Examples

### Historical links with `status=any`, filters, and pagination

```bash
curl -s "http://localhost:8787/v1/links?status=any&topic=politics&after=2026-03-01T00:00:00Z&limit=25&offset=25" \
  -H "x-pmci-api-key: $PMCI_API_KEY" | jq '{total, limit, offset, filters, sample: .links[0]}'
```

---

## Error Reference

| HTTP | Body                                                | When                                          |
|------|-----------------------------------------------------|-----------------------------------------------|
| 401  | `{"error":"unauthorized"}`                          | Wrong or missing API / admin key              |
| 429  | `{"error":"rate_limited","message":"..."}`          | > 60 req/min — check `X-RateLimit-*` headers |
| 503  | `{"error":"stale_data","lag_seconds":N,...}`        | `/v1/signals/*` when observer lag > threshold |
| 200  | `{"error":{"fieldErrors":{},"formErrors":[]}}`      | Zod validation failure (bad query params)     |
| 200  | `{"error":"unknown_provider"}`                      | Provider code not in `pmci.providers`         |

---

## Response Headers

| Header           | Present on   | Example           |
|------------------|--------------|-------------------|
| `X-PMCI-Version` | All routes   | `"2026-03-02"`    |
| `X-RateLimit-Limit`    | Rate-limited routes | `60`      |
| `X-RateLimit-Remaining`| Rate-limited routes | `59`      |
| `Retry-After`    | 429 responses| `60`              |

---

## Key Schema Shapes

### `FreshnessResponse`
```json
{
  "status": "ok",
  "lag_seconds": 30,
  "latest_by_provider": [
    { "provider": "kalshi", "lag_seconds": 30 }
  ],
  "counts": { "provider_markets": 1336, "snapshots": 306329, "families": 61, "current_links": 122 }
}
```

### `ObserverHealthResponse`
```json
{
  "status": "ok",
  "configured_pair_success_rate": 0.98,
  "true_success_rate": {
    "window_minutes": 30,
    "pairs_attempted": 1820,
    "pairs_succeeded": 1489,
    "pairs_failed": 331,
    "failure_rate": 0.182,
    "alert": true,
    "alert_threshold": 0.1,
    "alert_reason": "polymarket_pair_failure_rate_exceeded",
    "by_provider": {}
  },
  "pairs_configured_total": 854,
  "rolling_window_cycles": 20,
  "error_totals": { "kalshi_fetch_errors": 0, "polymarket_fetch_errors": 0, ... }
}
```

### `TopDivergenceResult`
```json
{
  "family_id": 7,
  "label": "politics::trump::::harris",
  "consensus_price": 0.52,
  "max_divergence": 0.04,
  "legs": [
    { "provider": "kalshi", "price_yes": 0.54, "divergence": 0.02 },
    { "provider": "polymarket", "price_yes": 0.50, "divergence": 0.02 }
  ]
}
```

### `ReviewQueueItem`
```json
{
  "proposed_id": 42,
  "confidence": 0.91,
  "proposed_relationship_type": "equivalent",
  "market_a": { "provider": "kalshi", "title": "...", "latest_snapshot": { "price_yes": 0.54 } },
  "market_b": { "provider": "polymarket", "title": "...", "latest_snapshot": { "price_yes": 0.52 } }
}
```
