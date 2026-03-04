# PMCI vertical slice – PR plan & DoD

Migration history is clean; schema verified. This doc tracks the first working PMCI slice in the live DB and API.

## Priority order

1. **PMCI ingestion from observer** – upsert `pmci.provider_markets`, append `pmci.provider_market_snapshots` (DEM/GOP only).
2. **Seed families + links from event_pairs** – create `pmci.market_families` and `pmci.market_links` (equivalent, 0.99, reasons), respect `v_market_links_current`, link_version.
3. **API returns real data** – confirm `/v1/providers`, `/v1/coverage`, `/v1/market-families`, `/v1/market-links`, `/v1/signals/divergence`, `POST /v1/resolve/link` return real rows.

---

## Step 1: PMCI ingestion from observer

**Definition of done:** PMCI tables are populated continuously from the existing observer; no manual backtest needed.

**Files touched:**
- `lib/pmci-ingestion.mjs` (new) – pg client helper, upsert provider_markets, append snapshots, optional ingestion report.
- `observer.mjs` – load `DATABASE_URL`; after each successful spread insert (or at end of event cycle), call PMCI ingestion for that pair; log ingestion report per cycle.

**SQL used:**
- Upsert `pmci.provider_markets` on `(provider_id, provider_market_ref)` with `RETURNING id`.
- Insert `pmci.provider_market_snapshots` (provider_market_id, observed_at, price_yes, best_bid_yes, best_ask_yes, liquidity, volume_24h, raw).

**Scope:** Current DEM/GOP nominee pairs only (same config as observer). No new providers.

**Ingestion report (per run):** markets_upserted, snapshots_appended; optional per-event breakdown.

---

## Step 2: Seed families + links from event_pairs ✅

**Definition of done:** `/v1/market-families` and `/v1/market-links` return real rows; links have relationship_type=equivalent, confidence≈0.99, reasons JSON.

**Implemented:**
- `scripts/seed-pmci-families-links.mjs` – reads event_pairs (scripts/prediction_market_event_pairs.json or event_pairs.json), resolves provider_market ids from `pmci.provider_markets`, creates `pmci.market_families` by label `event_id::candidate`, inserts `pmci.market_links` with link_version (via `pmci.linker_runs`), reasons: mapping_source, event_name, candidate, event_id. Skips pairs when markets are missing or links already exist.
- npm script: `npm run seed:pmci`.

**Order:** Run the observer at least one cycle (with `DATABASE_URL` set) so `pmci.provider_markets` is populated, then run `npm run seed:pmci`.

---

## Step 3: API returns real data

**Definition of done:** All listed endpoints return non-empty data when DB is populated; POST /v1/resolve/link creates/updates links with evidence.

**Files touched:** None if step 1+2 are done (API already reads from pmci.*). Verify with manual or automated smoke test.

---

## Schema / migrations

- No new migration for step 1: `pmci.provider_markets` and `pmci.provider_market_snapshots` already have required columns.
- If step 2 discovers missing columns (e.g. on market_families), add a single new migration.

---

## Scope guardrails

- No trading execution.
- No new providers (Kalshi + Polymarket only).
- Deterministic, debuggable: logs + ingestion report per observer run.
