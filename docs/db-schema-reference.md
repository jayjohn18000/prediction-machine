# PMCI DB Schema Reference

_Last verified: 2026-05-01 (Track B sub-agent)_

_Read this at session start before writing any DB queries or making API calls._

_All physical tables live in schema `pmci` unless noted. Types below mirror `information_schema` on production (Postgres): `bigint`=int8, `smallint`=int2, `numeric`, `uuid`, `timestamptz`, `interval`, enums `market_type`, `relationship_type`._

---

## Key tables and column names

### `pmci.providers`

| Column | Type | Notes |
|--------|------|-------|
| `id` | smallint | PK |
| `code` | text | e.g. `kalshi`, `polymarket` |
| `name` | text | Display name |
| `created_at` | timestamptz | |

---

### `pmci.provider_markets`

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint | PK — join target for snapshots, links, outcomes |
| `provider_id` | smallint | FK → `pmci.providers` |
| `provider_market_ref` | text | Kalshi ticker or Polymarket condition/ref string |
| `event_ref` | text | Venue event grouping key when present |
| `title` | text | Market title |
| `category` | text | politics, sports, etc. |
| `url` | text | Venue URL |
| `market_type` | `market_type` | ENUM |
| `resolution_source` | text | |
| `open_time` | timestamptz | |
| `close_time` | timestamptz | Used for stale-active detection |
| `status` | text | Kalshi: often `active` (not `open`) |
| `metadata` | jsonb | Venue-specific payloads; Kalshi series often `metadata->>'series_ticker'` |
| `first_seen_at` | timestamptz | |
| `last_seen_at` | timestamptz | |
| `title_embedding` | vector | Optional pgvector embedding |
| `election_phase`, `subject_type` | text | Politics metadata |
| `sport` | text | `'unknown'` until inferred |
| `event_type` | text | |
| `game_date` | date | |
| `home_team`, `away_team` | text | |
| `volume_24h` | numeric | |
| `market_template` | text | |
| `template_params` | jsonb | |

> **Gotcha:** `series_ticker` for Kalshi is usually `metadata->>'series_ticker'`, not a top-level column.

---

### `pmci.provider_market_snapshots`

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint | PK |
| `provider_market_id` | bigint | FK → `provider_markets.id` |
| `observed_at` | timestamptz | |
| `price_yes`, `price_no` | numeric | Mid-derived or venue mid |
| `best_bid_yes`, `best_ask_yes` | numeric | Order book YES side |
| `liquidity`, `volume_24h` | numeric | |
| `raw` | jsonb | Original payload snippet |

---

### `pmci.market_outcomes` (settled markets)

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint | PK |
| `provider_market_id` | bigint | FK → `provider_markets` — effectively one current row per market |
| `provider_id` | smallint | |
| `winning_outcome` | text | |
| `winning_outcome_raw` | jsonb | |
| `resolved_at` | timestamptz | |
| `resolution_source_observed` | text | |
| `raw_settlement` | jsonb | Audit blob |
| `ingested_at` | timestamptz | |
| `updated_at` | timestamptz | |

**Join:** `pmci.v_market_links_current` → `provider_market_id` → `market_outcomes.provider_market_id`.

### `pmci.market_outcome_history`

Append-only audit companion to `market_outcomes` — same semantics plus `recorded_at` (historical ingest trail).

---

### `pmci.canonical_events`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `slug`, `title` | text | |
| `category`, `description` | text | |
| `start_time`, `end_time`, `resolves_at`, `resolved_at`, `event_time` | timestamptz | |
| `event_date` | date | |
| `metadata`, `participants` | jsonb | |
| `external_ref`, `external_source`, `resolution_source`, `source_annotation`, `lifecycle`, `subcategory` | text | |
| `created_at`, `updated_at` | timestamptz | |

---

### `pmci.market_families`

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint | PK |
| `canonical_event_id`, `canonical_market_id` | uuid | Event / optional canonical market linkage |
| `label`, `notes` | text | |
| `created_at`, `updated_at` | timestamptz | |

---

### `pmci.market_links`

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint | PK |
| `family_id` | bigint | FK → `market_families.id` |
| `provider_id` | smallint | FK → `providers` (**not** a `provider` text column) |
| `provider_market_id` | bigint | FK → `provider_markets.id` |
| `relationship_type` | `relationship_type` | ENUM |
| `status` | text | e.g. `active`; `removed_at`/`removed_reason` when dropped |
| `link_version` | integer | |
| `confidence`, `staleness_score`, `break_rate`, `correlation_strength` | numeric | |
| `correlation_window` | interval | |
| `lag_seconds` | integer | |
| `last_validated_at` | timestamptz | |
| `reasons` | jsonb | |
| `created_at`, `updated_at`, `removed_at` | timestamptz | |
| `removed_reason` | text | |

> **Gotcha:** There is **no** `score` column. Qualify `status` (`ml.status` vs `pm.status`) when joining `market_links` to `provider_markets`.

---

### `pmci.proposed_links`

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint | PK |
| `category` | text | |
| `provider_market_id_a`, `provider_market_id_b` | bigint | FK-ish to `provider_markets.id` |
| `proposed_relationship_type`, `accepted_relationship_type`, `decision` | text | |
| `confidence`, `features`, `reasons` | numeric / jsonb | |
| `created_at`, `reviewed_at` | timestamptz | |
| `reviewer_note` | text | |
| `accepted_family_id` | bigint | |
| `accepted_link_version` | integer | |

> **Gotcha:** Rejected pairs stay skipped by proposers until `decision` is cleared back to pending semantics (operator choice).

---

### `pmci.review_decisions`

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigint | PK |
| `proposed_link_id` | bigint | FK → `proposed_links.id` |
| `decision`, `relationship_type`, `reviewer_note` | text | |
| `reviewed_at` | timestamptz | |

---

### `pmci.mm_orders` / `pmci.mm_fills` (MM runtime)

**`mm_orders`:** `id`, `market_id`, `kalshi_order_id`, `client_order_id`, `side`, `price_cents`, `size_contracts`, `status`, `placed_at`, `filled_at`, `fill_*`, `fair_value_at_place`, `payload`.

**`mm_fills`:** `id`, `order_id`, `market_id`, `observed_at`, `price_cents`, `size_contracts`, `side`, `fair_value_at_fill`, `post_fill_mid_*`, `adverse_cents_5m`, `kalshi_fill_id`.

---

## Upsert behavior

The `provider_markets` upsert uses:

```sql
sport = COALESCE(EXCLUDED.sport, provider_markets.sport)
```

So non-null ingestion values replace prior `'unknown'` sport — safe to re-run backfills without clobbering good data.

---

## API auth headers

| Endpoint pattern | Required header | Value |
|------------------|-----------------|-------|
| `/v1/review/*` | `x-pmci-api-key` | `process.env.PMCI_API_KEY` |
| `/v1/resolve/link` | `x-pmci-admin-key` | `process.env.PMCI_ADMIN_KEY` |

> **Gotcha:** `src/server.mjs` enforces `x-pmci-api-key` for standard routes — do **not** send only admin key to review endpoints.

---

## Proposed_links → acceptance flow

1. Proposer (`npm run pmci:propose:*`) inserts `pmci.proposed_links` rows with pending `decision`.
2. Review via `GET /v1/review/queue` (Sunset labelled in OpenAPI Track B — still valid mechanically).
3. Accept example:

```
POST http://localhost:8787/v1/review/decision
Headers: x-pmci-api-key: <PMCI_API_KEY>
Body: { "proposed_id": <number>, "decision": "accept", "relationship_type": "equivalent" }
```

(`proposed_id` must parse as integer in JSON.)

4. Acceptance creates/links `market_families` plus `market_links` rows inside the resolver transaction path.

---

## Stale-active markets

`status='active'` with `close_time < now()` pollutes proposers — clear via `node scripts/stale-cleanup.mjs` (guard-first: skips markets with active links).

---

## Provider market ref quirks

| Provider | Stored field | Typical shape |
|----------|--------------|---------------|
| Kalshi | `provider_market_ref` | Series ticker + market suffix, e.g. `KXMLBODDS-25MAY12-NYM` |
| Polymarket | `provider_market_ref` / `event_ref` | Hex-ish condition identifiers plus human titles |

Polymarket tag IDs behave as unstable numeric-string metadata — rely on titles + taxonomy helpers for sport inference, not brittle ID maps.

---

## Sport inference pointers

- **Kalshi:** use `(seriesTitle, seriesTicker)` in `inferSportFromKalshiTicker` — title first.
- **Polymarket:** prefer `inferSportFromPolymarketTitle(title, tags)`; tag buckets vary by environment.
- Backfill CLI: `node scripts/backfill-sport-inference.mjs`.
