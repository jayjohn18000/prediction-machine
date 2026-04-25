---
title: Phase — Market Making MVP (Kalshi)
phase: mm-mvp
status: proposed
start-date: 2026-04-24
parent-pivot: docs/archive/pivot-2026-04/
thesis-brainstorm: ~/Documents/Claude/Projects/Prediction Machine/_inbox/thesis-brainstorm-kalshi-poly-structures.md
---

# Phase — Market Making MVP (Kalshi)

> Architecture sketch for the successor thesis after the 2026-04-24 arb pivot closed RED. Produces a live, toy-size, autonomous market-making system on Kalshi with Polymarket as an information source (no Poly execution — US-resident geoblock).

## Goal

Stand up an MM runtime that:

1. Posts two-sided quotes on a hand-picked set of **retail-heavy, low-news Kalshi markets**.
2. Anchors fair value to an EMA of Kalshi midpoint, optionally blended with the same-event Polymarket midpoint when that event exists.
3. Manages inventory risk via **skewed quotes, position limits, and auto-flatten rules**.
4. Tracks adverse selection per-market and **auto-kills toxic markets**.
5. Produces a daily P&L ledger with attribution: **spread capture vs adverse selection vs inventory drift**.

### MVP exit criteria

- 5 markets quoted continuously for 7 days
- Net positive P&L after adverse-selection cost over that window
- ≤1 auto-flatten event
- Zero risk-limit breaches
- Per-market P&L attribution is legible (spread capture dollars separately from adverse selection dollars)

## Explicitly out of scope for MVP

- Latency-optimized hot path (Rust, colocation, WS multiplexing). Node REST polling is fine at toy size.
- Multi-venue execution. Kalshi only. Polymarket is read-only information source.
- Proper statistical sport/event model as fair-value driver. MVP uses EMA + Poly anchor; model-driven fair-value is v2.
- Dynamic market selection / auto-discovery. MVP uses a hand-curated 5-market universe.
- ML / training pipelines.
- Multi-leg or basket strategies.

## High-level dataflow

```
    Kalshi REST / WS                     Polymarket on-chain (read-only)
         │                                        │
         ▼                                        ▼
   observer (extended)                    poly-wallet-indexer
   ┌────────────────┐                     ┌────────────────────┐
   │ depth snapshots │                    │ trades + positions │
   │ price history   │                    │ per wallet/market  │
   └────────┬───────┘                     └─────────┬──────────┘
            │                                       │
            ▼                                       ▼
        Supabase                                Supabase
   ┌────────────────┐                     ┌────────────────────┐
   │ provider_      │                     │ poly_wallet_*      │
   │ market_depth   │                     │ v_poly_sharp_*     │
   └────────┬───────┘                     └─────────┬──────────┘
            │                                       │
            └────────────────┬──────────────────────┘
                             ▼
                  ┌─────────────────────────┐
                  │ fair-value engine       │
                  │ lib/mm/fair-value.mjs   │
                  └────────────┬────────────┘
                               │
                               ▼
                  ┌─────────────────────────┐   inventory state
                  │ quoting engine          │ ◀───  mm_positions
                  │ lib/mm/quoting.mjs      │
                  └────────────┬────────────┘
                               │
                               ▼
                  ┌─────────────────────────┐   auto-flatten, kill,
                  │ risk manager            │   limits, stale-cancel
                  │ lib/mm/risk.mjs         │
                  └────────────┬────────────┘
                               │
                               ▼
                  ┌─────────────────────────┐
                  │ kalshi-trader client    │
                  │ lib/providers/          │
                  │ kalshi-trader.mjs       │
                  └────────────┬────────────┘
                               │
                               ▼                  Supabase
                           Kalshi             ┌──────────────┐
                             API              │ mm_orders    │
                               │              │ mm_fills     │
                               └─────────────▶│ mm_positions │
                                              │ mm_pnl       │
                                              └───────┬──────┘
                                                      │
                                                      ▼
                                          ┌───────────────────────┐
                                          │ adverse-selection     │
                                          │ tracker               │
                                          │ lib/mm/toxicity.mjs   │
                                          └───────────────────────┘
```

## New components

### 1. `lib/providers/kalshi-trader.mjs`
WRITE-side Kalshi client. Imports auth and session plumbing from existing `lib/providers/kalshi.mjs`. Exposes:
- `createOrder({market_ticker, side, price_cents, size_contracts, client_order_id})`
- `cancelOrder(kalshi_order_id)`
- `cancelAllInMarket(market_ticker)`
- `getOpenOrders(market_ticker?)`
- `getPosition(market_ticker)`

Rate-limit aware; respects Kalshi's per-API-key throttles. Idempotent via `client_order_id`.

### 2. `lib/ingestion/depth.mjs` + observer extension
Extends the observer loop to ingest L2 order-book depth from Kalshi's WebSocket endpoint. Writes to new `pmci.provider_market_depth` table. Samples every 250ms at toy scale; downsamples to 1s for persistent storage, keeps 250ms in memory for the quoting engine to consume.

### 3. `lib/mm/fair-value.mjs`
Pure function. Input: recent price history + optional Polymarket reference price. Output: `{fair_value_cents, confidence, staleness_ms}`.

- **v0 (MVP):** EMA of Kalshi midpoint with 30s half-life. If same-event Polymarket market exists, blend weighted by relative liquidity: `fair = (L_k × mid_k + L_p × mid_p) / (L_k + L_p)` on top of the EMA.
- **v1:** Add realized-vol estimate and time-of-day adjustments.
- **v2 (post-MVP):** Swap in a proper statistical model per sport/event category. The interface is the same; only the internals change.

### 4. `lib/mm/quoting-engine.mjs`
Takes `(fair_value, inventory, vol_estimate, market_config) → (bid_price, bid_size, ask_price, ask_size)`. Rules:

- Base half-spread = `max(min_half_spread_cents, k_vol × vol_estimate_cents)`
- Bid = `fair - half_spread`, Ask = `fair + half_spread`
- **Inventory skew:** if `|inventory| > soft_limit`, shift both quotes toward reducing exposure by `skew_bps × (inventory / hard_limit)`
- **Sizes:** step function — full size when flat, half near soft limit, zero above hard limit (one-sided only)
- **Quote throttling:** don't repost if new quote is within `min_requote_cents` of current quote (reduces cancel rate)

### 5. `lib/mm/risk.mjs`
Hard safety. Enforces:

- **Position limit** per market (absolute contracts)
- **Daily loss kill-switch** aggregated across markets
- **Per-market kill-switch** on N consecutive toxic fills (see toxicity tracker)
- **Auto-flatten** (aggressive close) on kill-switch fire
- **Stale-quote cancel** if no price update received for T seconds, cancel all active quotes

Risk checks run **before** any order reaches `kalshi-trader`. No order dispatch without passing risk.

### 6. `lib/mm/toxicity.mjs`
For each fill, log price at fill-time and price at `T+1m`, `T+5m`, `T+30m`. Aggregate per-market:

- Mean adverse price movement over 5m
- 90th-percentile adverse movement over 5m
- Rolling toxic-fill count over last 100 fills

**Toxic-market trigger:** if `5m_adverse_cents > mean_captured_spread_cents` over last 100 fills, fire market kill-switch.

### 7. `lib/mm/orchestrator.mjs`
The actual runtime loop. Reads active-markets list from config, subscribes to depth updates, computes fair value, emits quotes via `kalshi-trader`, reconciles fills, runs risk checks, writes P&L snapshots. One orchestrator per Fly app instance; only one instance per MM runtime (state consistency).

### 8. `lib/mm/backtest/`
**Separate from the archived A5 engine** (which was directional arb-trade, not MM). New engine that:

- Replays historical depth snapshots as if they were live
- Simulates fills using the quote-placement-vs-incoming-trade model
- Models adverse selection cost from post-fill price movement in the historical data
- Emits per-market, per-day PnL decomposition

## Supabase schema additions

```sql
-- Kalshi L2 order book snapshots.
-- NOTE (W1 spec-check 2026-04-24): renamed `bids/asks` → `yes_levels/no_levels`
-- to match Kalshi's actual WS shape — both sides are BID ladders (YES-bids and
-- NO-bids), not a bid/ask pair. YES-ask is derived at read time as
-- 100 - best_no_bid. Added UNIQUE (provider_market_id, observed_at) for
-- idempotent inserts by the 1Hz downsampler.
CREATE TABLE pmci.provider_market_depth (
  id                    bigserial PRIMARY KEY,
  provider_market_id    bigint NOT NULL REFERENCES pmci.provider_markets(id),
  observed_at           timestamptz NOT NULL,
  yes_levels            jsonb NOT NULL,   -- YES-bid ladder [[price_cents, qty], ...] top 10 by price desc
  no_levels             jsonb NOT NULL,   -- NO-bid ladder [[price_cents, qty], ...] top 10 by price desc
  mid_cents             numeric,          -- (best_yes_bid + (100 - best_no_bid)) / 2
  spread_cents          int,              -- (100 - best_no_bid) - best_yes_bid
  UNIQUE (provider_market_id, observed_at)
);
CREATE INDEX ON pmci.provider_market_depth (provider_market_id, observed_at DESC);

-- MM-placed orders (includes open, filled, cancelled, rejected)
CREATE TABLE pmci.mm_orders (
  id                    bigserial PRIMARY KEY,
  market_id             bigint REFERENCES pmci.provider_markets(id),
  kalshi_order_id       text UNIQUE,
  client_order_id       text UNIQUE NOT NULL,
  side                  text NOT NULL CHECK (side IN ('yes_buy','yes_sell','no_buy','no_sell')),
  price_cents           int NOT NULL,
  size_contracts        int NOT NULL,
  status                text NOT NULL CHECK (status IN ('pending','open','filled','partial','cancelled','rejected')),
  placed_at             timestamptz NOT NULL,
  filled_at             timestamptz,
  fill_price_cents      int,
  fill_size_contracts   int,
  fair_value_at_place   numeric,
  payload               jsonb
);

-- Every fill we took, with post-fill price tracking for adverse selection
CREATE TABLE pmci.mm_fills (
  id                    bigserial PRIMARY KEY,
  order_id              bigint REFERENCES pmci.mm_orders(id),
  market_id             bigint REFERENCES pmci.provider_markets(id),
  observed_at           timestamptz NOT NULL,
  price_cents           int NOT NULL,
  size_contracts        int NOT NULL,
  side                  text NOT NULL,
  fair_value_at_fill    numeric NOT NULL,
  post_fill_mid_1m      numeric,
  post_fill_mid_5m      numeric,
  post_fill_mid_30m     numeric,
  adverse_cents_5m      numeric GENERATED ALWAYS AS (post_fill_mid_5m - fair_value_at_fill) STORED
);

-- Current position per market
CREATE TABLE pmci.mm_positions (
  market_id             bigint PRIMARY KEY REFERENCES pmci.provider_markets(id),
  net_contracts         int NOT NULL DEFAULT 0,
  avg_cost_cents        numeric,
  realized_pnl_cents    numeric DEFAULT 0,
  unrealized_pnl_cents  numeric,
  last_updated          timestamptz NOT NULL
);

-- Hourly P&L attribution snapshots
CREATE TABLE pmci.mm_pnl_snapshots (
  id                          bigserial PRIMARY KEY,
  market_id                   bigint REFERENCES pmci.provider_markets(id),
  observed_at                 timestamptz NOT NULL,
  spread_capture_cents        numeric,
  adverse_selection_cents     numeric,
  inventory_drift_cents       numeric,
  fees_cents                  numeric,
  net_pnl_cents               numeric
);

-- Per-market risk limits (hand-curated in MVP)
CREATE TABLE pmci.mm_market_config (
  market_id             bigint PRIMARY KEY REFERENCES pmci.provider_markets(id),
  enabled               boolean NOT NULL DEFAULT false,
  soft_position_limit   int NOT NULL,
  hard_position_limit   int NOT NULL,
  min_half_spread_cents int NOT NULL,
  base_size_contracts   int NOT NULL,
  k_vol                 numeric NOT NULL DEFAULT 1.0,
  kill_switch_active    boolean NOT NULL DEFAULT false,
  last_toxicity_score   numeric,
  notes                 text
);
```

## Deployment

New Fly.io app `pmci-mm-runtime`:
- Separate from observer (different scaling profile) and API (different failure mode)
- Single-instance (state tracking; two orchestrators would double-quote)
- Config: `deploy/fly.mm.toml`
- Scaling: 1 shared-cpu-1x, 512MB. Upgrade when toy size grows.
- Health check: `/health/mm` endpoint on a small admin HTTP server returns orchestrator loop status.

Pausing MM is as simple as `fly scale count 0 -a pmci-mm-runtime`. Does not affect observer or API.

## W1 spec-check corrections (2026-04-24)

The following plan assumptions were corrected during W1 kickoff against the
live Kalshi WebSocket spec (`https://docs.kalshi.com/getting_started/quick_start_websockets`):

1. **Demo WS URL.** Correct path is `wss://demo-api.kalshi.co/trade-api/ws/v2` (not `.../trade-api/v2/ws` as referenced elsewhere).
2. **Subscribe channels.** Subscribe to `orderbook_delta` only. Kalshi sends an initial message of type `orderbook_snapshot` as the first message on the subscription; subsequent messages are `orderbook_delta`. There is no separate `orderbook_snapshot` channel to subscribe to.
3. **Schema column naming** (see `## Supabase schema additions` above). `bids/asks` → `yes_levels/no_levels`. Added `UNIQUE (provider_market_id, observed_at)` for idempotency.
4. **WebSocket auth** — omitted from the original plan but required on connection:
   - Headers: `KALSHI-ACCESS-KEY` (key id), `KALSHI-ACCESS-SIGNATURE` (RSA-PSS signed, base64), `KALSHI-ACCESS-TIMESTAMP` (unix ms).
   - Sign string: `{timestamp_ms}GET/trade-api/ws/v2` (path has no query params).
   - Algorithm: RSA-PSS with SHA-256, MGF1 SHA-256, salt length = digest length.
   - Implemented in `lib/providers/kalshi-ws-auth.mjs`; reusable by `kalshi-trader.mjs` (W2).
5. **Node dependency.** `ws@^8` added to `package.json` — Node has no suitable built-in WebSocket client for this workload.

## Build sequence

1. **W1: Depth ingestion + schema.** Add `provider_market_depth`. Extend observer with Kalshi L2 WS subscription for a hand-picked 5-market universe. Verify data lands cleanly.
2. **W2: Write client + order schema.** Build `kalshi-trader.mjs`. Add `mm_orders`, `mm_fills`, `mm_positions`, `mm_market_config` tables. Dry-run single create+cancel against Kalshi production to confirm plumbing.
3. **W3: Fair-value v0 + quoting engine v0.** EMA-based fair value. Symmetric quoter, no inventory skew or risk layer yet. Start emitting quotes at 1-contract size on 1 market only for live test.
4. **W4: Risk manager + inventory skew.** Add position limits, daily loss cap, auto-flatten, inventory skew. Expand to 5-market universe at 1-contract size.
5. **W5: Toxicity tracker + market kill-switch.** Log post-fill prices. Build per-market toxicity score. Auto-kill toxic markets.
6. **W6: P&L decomposition + dashboard.** Fill `mm_pnl_snapshots` hourly. Minimal internal admin page showing per-market spread-capture vs adverse-selection attribution.

**First live fills target:** end of W3.
**MVP exit criteria target:** end of W6.

## Carryover from archived pivot

Reusable directly:
- `lib/resolution/` (A1) — settlement tracking for realized P&L when markets resolve
- `lib/execution/costs.mjs` (A2) — fee calculation (the lockup portion is not needed for MM)
- `lib/backfill/polymarket-snapshot-recovery.mjs` — useful when the Poly wallet indexer is backfilling
- Observer pattern and Supabase + Fly topology

**Not reused:**
- `lib/backtest/*` (A5) — directional arb; does not fit MM semantics. New MM backtest engine is net-new code.
- `docs/archive/pivot-2026-04/pivot/success-rubric.md` — arb-specific rubric. MM has its own exit criteria defined above.

## Invariants (to add to `CLAUDE.md` when scaffolding starts)

- MM runtime must never place an order where `price_cents × size_contracts > risk_config.max_order_notional_cents`.
- Kalshi write client (`lib/providers/kalshi-trader.mjs`) must be instantiated **only from `lib/mm/orchestrator.mjs`**. Never from API routes, observer, or backtest code.
- Every `mm_fills` row must have `fair_value_at_fill` populated at insert time. No retrospective backfill.
- MM deployment must be a single Fly instance. Never scale count > 1 without implementing leader election.
- Toxicity kill-switch, once fired, requires manual human reset via a DB update. Never auto-unkill.

## Decisions resolved 2026-04-24

1. **Kalshi L2 depth via WS: YES, confirmed.** Endpoint `wss://trading-api.../v2/ws`. Supports `orderbook_snapshot` and `orderbook_delta` messages. Use delta-maintained local book rather than full-snapshot polling. The `lib/ingestion/depth.mjs` extension subscribes to these channels for the 5-market universe.
2. **MVP universe (5 markets, diversified across PMCI's currently-ingested categories — sports/politics/crypto/economics):**
   - 2× retail-heavy sports: candidates in priority order — MLS individual match winners (non-flagship pairings only), NBA team regular-season win totals on non-playoff-contending teams. Final picks deferred to W1 based on what's active in `provider_markets`.
   - 1× non-flagship politics: state-level race or specific bill passage. Explicitly NOT 2028 presidential.
   - 1× crypto price-range: BTC daily/weekly close range from KXBTC series (retail-heavy, low sharp density).
   - 1× economics: CPI reading range from the relevant KX series (NOT Fed Funds — sharp-dominated and tied tightly to SOFR futures).
3. **Kalshi API rate limits:** confirmed free for verified users. Specific numeric limits live at `docs.kalshi.com/getting_started/rate_limits` — verify at start of W2 when writing auth layer. MVP design assumes conservative rates: ≥250ms between REST calls, continuous WS subscription.
4. **Demo sandbox: YES, confirmed at `https://demo-api.kalshi.co/trade-api/v2` + WS at `wss://demo-api.kalshi.co/trade-api/v2/ws`.** Separate API keys, mock funds, full-featured. Weeks 1–3 (depth ingestion, write client plumbing, first fair-value + quoting live) run entirely in demo. Week 4 switches the runtime to production config at 1-contract size.
