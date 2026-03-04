# prediction-machine

Observation-only data capture for prediction market spreads (Kalshi vs Polymarket). Fetches YES prices per candidate, computes spread, inserts rows into Supabase. No trading or dashboards.

## Setup

1. **Copy env and set keys**
   ```bash
   cp .env.example .env
   ```
   Edit `.env`: set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) for your Supabase project.

2. **Create table (Supabase CLI)**  
   Install includes the Supabase CLI. Log in, link the project, and push migrations:
   ```bash
   npx supabase login
   npx supabase link --project-ref awueugxrdlolzjzikero
   npx supabase db push
   ```
   When linking, use your database password (Supabase Dashboard → Project Settings → Database).  
   Alternatively, run `sql/prediction_market_spreads.sql` in the Supabase SQL editor.

   **After `db push`:** if the API reports "Could not find the table ... in the schema cache", either:
   - **Option A:** In **Supabase Dashboard → SQL Editor**, run `NOTIFY pgrst, 'reload schema';` (and if needed, `SELECT pg_notification_queue_usage();`), then retry; or
   - **Option B:** Set **DATABASE_URL** in `.env` to your project’s Postgres connection string (Dashboard → Settings → Database → Connection string, e.g. Transaction pooler). The API will use direct SQL for `/signals/top` and `/execution-decision`, bypassing PostgREST.

3. **Install and run**
   ```bash
   npm install
   npm run start
   ```
   Or: `npm run observe:spreads`

## Env vars

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes* | Anon key (or use `SUPABASE_SERVICE_ROLE_KEY`) |
| `SPREAD_EVENT_PAIRS_PATH` | No | Config JSON path (default: `./event_pairs.json`) |
| `SPREAD_OBSERVER_INTERVAL_SEC` | No | Seconds between cycles (default: 60) |

## Config

`event_pairs.json`: array of `{ eventName, kalshiTicker, polymarketSlug, polymarketOutcomeName }`. One row per candidate per cycle.

### Expanding candidate coverage (2028 Democratic nominee)

To regenerate the list of candidates that exist on **both** Kalshi and Polymarket (no ticker guessing; all tickers from APIs):

```bash
npm run discover:dem2028
```

- Fetches Kalshi markets for event `KXPRESNOMD-28` and Polymarket event `democratic-presidential-nominee-2028`.
- Keeps only candidates present on both; writes `scripts/prediction_market_event_pairs.json`.
- Logs: found on both, missing on Kalshi, missing on Polymarket.

Use the generated file with the observer:  
`SPREAD_EVENT_PAIRS_PATH=scripts/prediction_market_event_pairs.json npm run start`

## Querying

```sql
SELECT * FROM prediction_market_spreads WHERE candidate = 'Josh Shapiro' ORDER BY observed_at DESC LIMIT 100;
```

### Execution edge (bid/ask)

Each row stores `kalshi_yes_bid`, `kalshi_yes_ask`, `polymarket_yes_bid`, `polymarket_yes_ask`, plus `kalshi_open_interest` and `kalshi_volume_24h`. An **executable** arbitrage exists when `kalshi_yes_bid > polymarket_yes_ask` (buy YES on Polymarket, sell YES on Kalshi). After 24–48 hours of data:

```sql
SELECT
  candidate,
  COUNT(*) FILTER (WHERE kalshi_yes_bid > polymarket_yes_ask) AS executable_edges
FROM prediction_market_spreads
GROUP BY candidate
ORDER BY executable_edges DESC;
```

---

## PMCI API (Phase 1)

The **Prediction Market Canonical Intelligence** layer lives in `src/` and uses the `pmci` schema in the same Supabase Postgres DB.

### Env (PMCI)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes (for PMCI) | Postgres connection string (e.g. Supabase → Settings → Database → Connection string) |
| `PORT` | No | PMCI API port (default 8787) |
| `PMCI_ADMIN_KEY` | No | If set, required header `x-pmci-admin-key` for `POST /v1/resolve/link` |

### PMCI ingestion from observer

With `DATABASE_URL` set in `.env`, the **spread observer** (`npm run start`) also writes to PMCI: it upserts `pmci.provider_markets` and appends `pmci.provider_market_snapshots` for each DEM/GOP nominee pair it processes. Each cycle logs e.g. `PMCI ingestion: markets_upserted=… snapshots_appended=…`. After PMCI tables have market data, seed families and links from config.

**Recommended order:** run the observer, then confirm ingestion, then smoke and seed:

1. **Observer** — `npm run start` (let it run 1–2 cycles; confirm log: "PMCI ingestion enabled …" and "PMCI ingestion: markets_upserted=… snapshots_appended=…").
2. **Probe** — `npm run pmci:probe` (prints DB name, counts, latest snapshot; exits non-zero if no markets yet).
3. **Smoke** — `npm run pmci:smoke` (must show provider_markets > 0, snapshots > 0).
4. **Seed** — `npm run seed:pmci` (creates families and links; prints slug => uuid for API use).

```bash
npm run seed:pmci
```

This creates `pmci.canonical_events` (by slug), `pmci.market_families` (with `canonical_event_id` set), and `pmci.market_links` from your event_pairs. The script prints canonical event UUIDs; use them for the API: `GET /v1/market-families?event_id=<uuid>` (the API expects the canonical_event UUID, not the slug).

### Run PMCI API

After `npm install` and `npx supabase db push` (so the `pmci` migration is applied):

```bash
npm run api:pmci
```

Endpoints: `GET /v1/providers`, `GET /v1/coverage`, `GET /v1/coverage/summary`, `GET /v1/markets/unlinked`, `GET /v1/markets/new`, `GET /v1/market-families`, `GET /v1/market-links`, `GET /v1/signals/divergence`, `GET /v1/signals/top-divergences`, `POST /v1/resolve/link` (admin).

#### Live mode (observer + freshness)

To keep PMCI **live** instead of static, run:

1. **API** — `npm run api:pmci`
2. **Observer** — `npm run start` (continuous spread + PMCI ingestion loop; runs semi-autonomously every `SPREAD_OBSERVER_INTERVAL_SEC` seconds and keeps snapshots fresh — keep this process running 24/7 for live data)
3. **Watch** — `npm run pmci:watch` (polls `/v1/health/freshness` and exits non-zero if lag remains high)

`GET /v1/health/freshness` returns:

```jsonc
{
  "status": "ok" | "stale" | "error",
  "now": "...",
  "latest_snapshot_at": "...",
  "lag_seconds": 42,
  "latest_by_provider": [{ "provider": "kalshi", "latest_snapshot_at": "...", "lag_seconds": 42 }],
  "counts": { "provider_markets": 122, "snapshots": 1098, "families": 61, "current_links": 122 }
}
```

Lag is measured from `pmci.provider_market_snapshots.observed_at`; `status` becomes `stale` when `lag_seconds > PMCI_MAX_LAG_SECONDS` (default 120) and `error` when there are no snapshots or a DB error.

#### Coverage API (map fragmented markets)

For bots and devs: see what exists per provider, what’s linked vs unlinked, and coverage ratio.

#### Politics universe ingestion (broaden beyond paired config)

By default, the observer only ingests markets from `scripts/prediction_market_event_pairs.json` (paired Kalshi↔Polymarket mappings).

To ingest a broader **POLITICS** universe (including venue-unique markets) into `pmci.provider_markets`, run:

```bash
npm run pmci:ingest:politics:universe
```

This script requires `DATABASE_URL` and uses optional env vars:

- `PMCI_POLITICS_KALSHI_SERIES_TICKERS` — comma-separated series tickers to crawl on Kalshi. Discover: `npm run pmci:discover:kalshi:politics`.
- `PMCI_POLITICS_POLY_TAG_ID` — Polymarket tag id for politics events.
- `PMCI_POLITICS_MAX_EVENTS_PER_PROVIDER` — limit crawl size (default 50).
- `PMCI_POLITICS_REQUEST_DELAY_MS` — delay between Kalshi request chunks (default 250; increase if you hit 429).
- `PMCI_POLITICS_KALSHI_CONCURRENCY` — Kalshi events per parallel chunk (default 1).
- `PMCI_POLITICS_KALSHI_MAX_EVENTS` — cap Kalshi events per run (default 50).
- `PMCI_POLITICS_KALSHI_MAX_RETRIES` — retries on 429/5xx with backoff (default 6).

Kalshi ingestion uses **429 retry with backoff** (and optional `Retry-After`). Progress is checkpointed to `.pmci_kalshi_universe_checkpoint.json`; pass `--reset` to start fresh: `npm run pmci:ingest:politics:universe -- --reset`.

Universe-ingested markets set `pmci.provider_markets.category = 'politics'`, so you can filter with `category=politics` on `/v1/markets/unlinked` and `/v1/markets/new`.

**Attribution test (observer OFF):** To confirm the universe script is appending snapshots (not the observer), stop the observer, then run `npm run pmci:ingest:politics:universe`, then `npm run pmci:check:poly`. The script fails if it appends 0 Polymarket snapshots despite visiting events. Snapshots written by the universe script have `raw._pmci.source = 'pmci-ingest-politics-universe'`; `pmci:check:poly` prints `universe_attributed=<n>`. Use `PMCI_REQUIRE_UNIVERSE_SNAPSHOTS=1` when running the check to require that count &gt; 0. **Acceptance:** still_missing_prices (from ingestion report `skipped_by_reason.missing_prices`) should decrease vs baseline 364 when derived prices are used; universe_attributed should increase.

- **GET /v1/coverage/summary?provider=kalshi&category=&since=** — `total_markets`, `linked_markets`, `unlinked_markets`, `coverage_ratio`. Optional `category` (e.g. event slug) and `since` (ISO or relative: `24h`, `7d`).
- **GET /v1/markets/unlinked?provider=kalshi&category=&since=&limit=20** — List provider markets not in any family (not in `v_market_links_current`). Sorted by `last_seen_at` desc. Use to find gaps or list candidates for linking.

**Example:** `curl -s "http://localhost:8787/v1/coverage/summary?provider=kalshi"` then `curl -s "http://localhost:8787/v1/markets/unlinked?provider=kalshi&limit=10"`.

#### New markets feed (detect listings early)

- **GET /v1/markets/new?provider=kalshi&since=24h&limit=20** — Markets with `first_seen_at >= since` (newly ingested). `since` required (e.g. `24h`, `7d`, or ISO). Sorted by `first_seen_at` desc. Lets bots react to new listings first.

**Example:** `curl -s "http://localhost:8787/v1/markets/new?provider=kalshi&since=24h&limit=10"`.

**Check:** `npm run pmci:check-coverage` (API must be running) verifies summary consistency and unlinked/new response shapes.

#### Top divergences (dashboard/alert feed)

`GET /v1/signals/top-divergences?event_id=<uuid>&limit=20` — Returns families for the canonical event ranked by max divergence (latest snapshots only). Each item: `family_id`, `label`, `consensus_price`, `max_divergence`, `last_observed_at`, `legs` (per-link provider, price_yes, divergence, relationship_type, confidence). Use the event UUID printed by `npm run seed:pmci` (e.g. DEM: `c8515a58-c984-46fe-ac65-25e362e68333`).

**Integration check:** With API running and data seeded, `curl -s "http://localhost:8787/v1/signals/top-divergences?event_id=c8515a58-c984-46fe-ac65-25e362e68333&limit=5"` should return an array of ≤5 items; when both legs have prices, each has non-null `max_divergence`. See `docs/PMCI-VERTICAL-SLICE-VALIDATION.md` for full curl sequence and failure diagnosis.

#### Phase 2: Proposals + Review

Politics link proposer generates **equivalent** and **proxy** suggestions; high-confidence equivalent can auto-accept; others go to a review queue.

- **Scripts:**  
  - `npm run pmci:propose:politics` — Proposes links (writes to `pmci.proposed_links`), optionally auto-accepts equivalent ≥ 0.985.  
  - `npm run pmci:review` — Fetches one item from the queue and optionally submits a decision (`--accept`, `--reject`, `--skip`; optional `--note "..."`).  
  - `npm run pmci:check:proposals` — Runs proposer once and checks `/v1/review/queue` returns a valid shape (API must be running for queue check).
- **Env caps:** `PMCI_MAX_PROPOSALS_EQUIV` (default 200), `PMCI_MAX_PROPOSALS_PROXY` (default 200), `PMCI_MAX_PER_BLOCK` (default 50).
- **API:**  
  - **GET /v1/review/queue?category=politics&limit=1&min_confidence=0.88** — Pending proposals with market cards and latest snapshot (price_yes, price_source).  
  - **POST /v1/review/decision** — Body: `{ proposed_id, decision: "accept"|"reject"|"skip", relationship_type: "equivalent"|"proxy", note? }`. Accept creates a family + active links so the pair appears in `/v1/market-families`, `/v1/market-links`, and `/v1/signals/top-divergences`.

**Runbook:**

1. `npm run pmci:ingest:politics:universe` — Ingest politics markets (observer OFF if attributing to universe only).
2. `npm run pmci:propose:politics` — Generate proposals (equivalent + proxy).
3. Start API: `npm run api:pmci` (or `node src/api.mjs`). Then `npm run pmci:review` to process one item; use `--accept` to accept, `--reject` or `--skip` otherwise.
4. Confirm: accepted links show up in `/v1/market-families`, `/v1/market-links`; unlinked count decreases; `/v1/signals/top-divergences` can include the new family when both legs have prices.

### Verify schema after migrations

After `npx supabase db push` (or applying migrations manually), confirm the remote PMCI schema matches what the code expects:

```bash
npx supabase migration list
npm run verify:schema
```

- **migration list** — Shows which migrations are recorded as applied (e.g. `20260225_000001_pmci_init`, `20260225100000_edge_windows_generation_filters`).
- **verify:schema** — Connects with `DATABASE_URL` and checks: `pmci` schema exists; required tables and columns (e.g. `market_links.reasons`, `provider_markets.provider_market_ref`) and view `pmci.v_market_links_current` exist. Prints PASS or FAIL and exits non-zero on failure.

If verification fails: re-apply the PMCI migration in the Supabase SQL Editor (run the contents of the migration file), or create a new migration that adds the missing tables/columns/view.
