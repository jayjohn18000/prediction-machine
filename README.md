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
