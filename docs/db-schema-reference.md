# PMCI DB Schema Reference

_Read this at session start before writing any DB queries or making API calls._
_Last updated: 2026-04-10 (E1.5 complete)_

---

## Key tables and column names

### `provider_markets`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `provider` | text | `'kalshi'` or `'polymarket'` |
| `provider_market_id` | text | Kalshi: ticker string; Polymarket: condition ID (hex) |
| `title` | text | Market title |
| `status` | text | Kalshi: `'active'` (not `'open'`); Polymarket: varies |
| `close_time` | timestamptz | Used for stale-active detection |
| `sport` | text | `'unknown'` if not yet inferred |
| `event_type` | text | |
| `game_date` | date | |
| `home_team` | text | |
| `away_team` | text | |
| `metadata` | jsonb | Extra provider-specific fields |
| `metadata->>'series_ticker'` | text | Kalshi series ticker (NOT a top-level column) |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

> **Gotcha:** `series_ticker` is stored in `metadata`, not as a column. Use `pm.metadata->>'series_ticker'` in SQL.

### `proposed_links`
| Column | Type | Notes |
|--------|------|-------|
| `id` | integer | PK — **pg returns this as a JS string; always `Number(p.id)` before use** |
| `category` | text | `'sports'`, `'politics'`, etc. |
| `provider_market_id_a` | text | |
| `provider_market_id_b` | text | |
| `proposed_relationship_type` | text | e.g. `'equivalent'` |
| `confidence` | numeric | 0.0–1.0 |
| `reasons` | jsonb | Array of reason strings |
| `decision` | text | `NULL` = pending, `'accepted'`, `'rejected'` |
| `created_at` | timestamptz | |

> **Gotcha:** Rows with `decision='rejected'` are NOT re-proposed by the proposer — they are skipped even if the underlying data has changed. To re-propose a previously rejected pair, reset `decision` to `NULL` first.

### `market_links`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `family_id` | uuid | FK → `families.id` |
| `provider` | text | `'kalshi'` or `'polymarket'` |
| `provider_market_id` | text | |
| `relationship_type` | text | `'equivalent'` |
| `status` | text | `'active'` |
| `link_version` | integer | |
| `confidence` | numeric | |
| `created_at` | timestamptz | |

> **Gotcha:** `market_links` has no `score` column. Don't select it.
> **Gotcha:** When joining `market_links ml` and `provider_markets pm`, both have a `status` column — qualify as `ml.status` or `pm.status` to avoid "ambiguous column" errors.

### `families`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `canonical_title` | text | |
| `category` | text | |
| `sport` | text | |
| `created_at` | timestamptz | |

---

## Upsert behavior

The `provider_markets` upsert uses:
```sql
sport = COALESCE(EXCLUDED.sport, provider_markets.sport)
```

This means: if a re-ingestion run provides a non-null `sport`, it **will overwrite** a previously-stored `'unknown'` value. You can safely re-run ingestion or the backfill script to fix `unknown` sport rows — it will not clobber rows that already have a correct sport.

---

## API auth headers

| Endpoint pattern | Required header | Value |
|-----------------|-----------------|-------|
| `/v1/review/*` | `x-pmci-api-key` | `process.env.PMCI_API_KEY` |
| `/v1/resolve/link` | `x-pmci-admin-key` | `process.env.PMCI_ADMIN_KEY` |

> **Gotcha:** The global auth hook in `src/server.mjs` reads `x-pmci-api-key`. Do NOT use `x-pmci-admin-key` for review endpoints — it will return 401 Unauthorized.

---

## Proposed_links → market_links acceptance flow

1. Proposer runs (`npm run pmci:propose:sports`) — writes rows to `proposed_links` with `decision=NULL`
2. Review: query `proposed_links WHERE decision IS NULL AND category='sports'`
3. Accept via API:
   ```
   POST http://localhost:3001/v1/review/decision
   Headers: x-pmci-api-key: <PMCI_API_KEY>
   Body: { "proposed_id": <Number(p.id)>, "decision": "accepted" }
   ```
   **Note:** `proposed_id` must be a number (integer), not a string.
4. On acceptance, the API creates one `families` row (or reuses existing) and two `market_links` rows (one per provider).

---

## Stale-active markets

A market is "stale-active" when `status='active'` but `close_time < NOW()`. These pollute the candidate pool for the proposer. Clear them with:
```bash
node scripts/stale-cleanup.mjs
```
The script is guard-first: it checks that none of the stale markets have active `market_links` before updating.

---

## Provider ID quirks

| Provider | `provider_market_id` format | Example |
|----------|----------------------------|---------|
| Kalshi | Series ticker + market suffix | `KXMLBODDS-25MAY12-NYM` |
| Polymarket | Hex condition ID | `0x3a4b...` |

Polymarket tag IDs (used in sport inference) are **numeric strings** like `"5"` or `"155"` — never match them against text pattern maps. Always use title-based fallback for Polymarket sport inference.

---

## Sport inference

- **Kalshi:** inference is series-level. Pass `(seriesTitle, seriesTicker)` to `inferSportFromKalshiTicker` — title is primary, ticker is fallback only.
- **Polymarket:** tag ID numeric strings are unreliable across environments; use `inferSportFromPolymarketTitle(title, tags)` with title fallback.
- DB backfill: `node scripts/backfill-sport-inference.mjs` — re-runs inference on all `unknown` sport Kalshi markets and updates DB directly.
