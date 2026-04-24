---
title: Phase — Polymarket On-chain Wallet Indexer
phase: poly-wallet-indexer
status: proposed
start-date: 2026-04-24
parent-thesis: mm-mvp (information source layer)
runs-parallel-with: phase-mm-mvp-plan.md
---

# Phase — Polymarket On-chain Wallet Indexer

> Extract, index, and expose wallet-level trading history from Polymarket's on-chain footprint on Polygon **without a Polymarket account or trading activity**. Works as an information source for the Kalshi MM MVP and as a standalone intelligence layer.

## Goal

Surface four kinds of signal from fully public on-chain data:

1. **Fair-value cross-reference** — Polymarket price as a second oracle for Kalshi fair-value estimation.
2. **Sharp/degen wallet classification** — a maintained list of wallets that consistently win and consistently lose, usable for copy / fade / flow toxicity decisions.
3. **Flow toxicity scoring** — real-time sharp-wallet activity on same-event Poly markets, fed to MM quoting engine for preemptive cancels.
4. **Market selection signal** — Poly volume indicates real interest; used to pick which Kalshi markets deserve MM attention.

## Legal & ToS posture

All data is public on the Polygon blockchain and is derived from raw chain state. **No Polymarket account is created. No trading activity. No interaction with Polymarket's API for user-account purposes.** This is analogous to reading public market data — no different in posture from reading SEC filings.

Polymarket's ToS prohibits US residents from trading. It does **not** prohibit US residents from reading public blockchain data. Infrastructure separates data ingestion (done here) from trading (which we are not doing).

## Data sources

1. **Polygon RPC** — HTTPS + WebSocket endpoint.
   - MVP: free public RPC (rate-limited, occasional reliability issues)
   - Production: paid Alchemy or Infura tier (~$50–200/mo), required for historical log depth and uptime
2. **Polymarket smart contracts on Polygon:**
   - CTF Exchange (conditional-token matching engine)
   - Conditional Tokens Framework (position token ledger)
   - UMA CTF Adapter (optimistic oracle for resolution)
   - Contract addresses captured at build time, verified on-chain, stored in a constants file
3. **Polymarket subgraph** (The Graph, hosted subgraph) — supplement for historical backfill; faster than walking raw RPC logs for the initial catch-up.
4. **Polymarket CLOB public REST API** — optional, for current order book depth on active markets only. No user-auth required for market-data endpoints.

## Ingestion pipeline

### Phase 1: Historical backfill
- Walk CTF Exchange logs from Polymarket deployment block to current head.
- Parse `OrderFilled`, `OrderCancelled`, and `TradeExecuted` events into normalized trade records.
- Chunked in 10k-block batches with retry + idempotency.
- Subgraph-first strategy for speed: pull pre-indexed history from The Graph, then verify against RPC for trust.
- Full backfill estimated: ~24–48 hours of indexer runtime against a paid RPC.

### Phase 2: Live tail
- WebSocket subscribe to new Polygon blocks.
- Filter for logs from Polymarket contract addresses.
- Parse and insert, idempotent on `(tx_hash, log_index)`.
- Target lag: ≤30 seconds from block confirmation to Supabase insert.

### Phase 3: Reorg handling
- Polygon has occasional reorgs up to ~32 blocks.
- **Confirmation delay:** trades are only marked `final=true` after 64 block confirmations (~130 seconds).
- Rows inserted as `final=false` are eligible for rewrite on reorg; rows at `final=true` are never rewritten.

### Phase 4: Nightly aggregation
- Batch job computes per-wallet stats (P&L, hit rate, volume, markets traded, win/loss expectancy) against resolved markets.
- Runs once per UTC day; refreshes `poly_wallet_stats` and the sharp/degen materialized views.

## Schema (Supabase)

```sql
-- Raw on-chain trade events — append-only, immutable once final=true
CREATE TABLE pmci.poly_wallet_trades (
  id                          bigserial PRIMARY KEY,
  tx_hash                     bytea NOT NULL,
  log_index                   int NOT NULL,
  block_number                bigint NOT NULL,
  block_time                  timestamptz NOT NULL,
  wallet_address              bytea NOT NULL,
  poly_market_condition_id    bytea NOT NULL,
  outcome_index               int NOT NULL,         -- 0 = YES, 1 = NO for binary
  side                        text NOT NULL CHECK (side IN ('buy','sell')),
  price_usdc                  numeric NOT NULL,     -- 1e-6 precision
  size_shares                 numeric NOT NULL,
  final                       boolean NOT NULL DEFAULT false,
  confirmed_at                timestamptz,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX ON pmci.poly_wallet_trades (wallet_address, block_time DESC);
CREATE INDEX ON pmci.poly_wallet_trades (poly_market_condition_id, block_time DESC);
CREATE INDEX ON pmci.poly_wallet_trades (block_time DESC) WHERE final = true;

-- Indexer high-water mark (single row), used for resume-after-restart
CREATE TABLE pmci.poly_indexer_cursor (
  id                  int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_block_number   bigint NOT NULL,
  last_updated        timestamptz NOT NULL
);

-- Current net position per wallet per market (derived from trades)
CREATE TABLE pmci.poly_wallet_positions (
  wallet_address              bytea NOT NULL,
  poly_market_condition_id    bytea NOT NULL,
  outcome_index               int NOT NULL,
  net_shares                  numeric NOT NULL,
  avg_cost_usdc               numeric,
  last_trade_time             timestamptz,
  PRIMARY KEY (wallet_address, poly_market_condition_id, outcome_index)
);

-- Nightly rolled-up per-wallet stats
CREATE TABLE pmci.poly_wallet_stats (
  wallet_address              bytea PRIMARY KEY,
  first_seen                  timestamptz,
  last_seen                   timestamptz,
  total_markets_traded        int,
  resolved_markets_traded     int,
  realized_pnl_usdc           numeric,
  unrealized_pnl_usdc         numeric,
  total_volume_usdc           numeric,
  hit_rate                    numeric,        -- resolved_wins / resolved_total
  win_loss_expectancy         numeric,        -- avg_win / |avg_loss|
  classification              text CHECK (classification IN ('sharp','degen','neutral','unclassified')),
  last_refreshed              timestamptz
);

-- Top sharps (materialized view, refreshed nightly)
CREATE MATERIALIZED VIEW pmci.v_poly_sharp_wallets AS
SELECT *
FROM pmci.poly_wallet_stats
WHERE resolved_markets_traded >= 20
  AND realized_pnl_usdc >= 1000
  AND hit_rate >= 0.55
  AND win_loss_expectancy >= 1.1
ORDER BY realized_pnl_usdc DESC
LIMIT 500;

-- Top degens (for fade signals)
CREATE MATERIALIZED VIEW pmci.v_poly_degen_wallets AS
SELECT *
FROM pmci.poly_wallet_stats
WHERE resolved_markets_traded >= 20
  AND realized_pnl_usdc <= -1000
  AND hit_rate <= 0.45
ORDER BY realized_pnl_usdc ASC
LIMIT 500;

-- Rolling 5-minute flow by classification, per market (for real-time MM consumption)
CREATE TABLE pmci.poly_market_flow_5m (
  poly_market_condition_id    bytea NOT NULL,
  window_end                  timestamptz NOT NULL,
  sharp_buy_volume_usdc       numeric NOT NULL DEFAULT 0,
  sharp_sell_volume_usdc      numeric NOT NULL DEFAULT 0,
  degen_buy_volume_usdc       numeric NOT NULL DEFAULT 0,
  degen_sell_volume_usdc      numeric NOT NULL DEFAULT 0,
  total_volume_usdc           numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (poly_market_condition_id, window_end)
);
```

## Computation layer

### Wallet P&L (nightly stats refresh)
- Walk `poly_wallet_trades WHERE final=true` ordered by time.
- Track running position per `(wallet, condition_id, outcome_index)` using weighted-avg cost.
- On resolution (market's `winning_outcome` known from UMA adapter), close position at 1 USDC per winning share, 0 USDC per losing share.
- Realized P&L = `(close_price - avg_cost) × shares` per closed position.
- Unrealized P&L = mark-to-market at current Polymarket CLOB mid price.

### Sharpness classification
- **Threshold for classification:** min 20 resolved markets traded AND min $10k total volume.
- **Sharp:** realized P&L ≥ $1k, hit rate ≥ 55%, win/loss expectancy ≥ 1.1.
- **Degen:** realized P&L ≤ –$1k, hit rate ≤ 45%.
- **Neutral:** meets thresholds for evaluation but not sharp or degen criteria.
- **Unclassified:** insufficient activity.

Classification is a snapshot as of the last nightly refresh; historical classifications are derivable from `poly_wallet_trades` if needed for backtesting.

### Flow signal (for MM real-time consumption)
Every 5 minutes:
- Compute per-market volume split by classification in the trailing 5m window.
- Insert into `poly_market_flow_5m`.
- Fire a Supabase Realtime event (or Postgres NOTIFY) on inserts — the MM orchestrator subscribes.
- MM orchestrator's rule: if `sharp_buy_volume_usdc ≥ 3 × sharp_sell_volume_usdc` AND total `sharp_volume ≥ $5k`, flag as "sharp flow UP" → pull any Kalshi asks on same-event market and requote tighter on the bid.

## Integration with MM MVP

1. **Fair-value adapter** — `lib/mm/fair-value.mjs` queries `v_polymarket_latest_prices` (existing observer-populated view) for same-event Poly market and blends into Kalshi midpoint when both exist.
2. **Flow toxicity adapter** — `lib/mm/quoting-engine.mjs` subscribes to `poly_market_flow_5m` inserts via Postgres NOTIFY (or Supabase Realtime) and preemptively cancels one-sided quotes on sharp-flow signals.
3. **Market selection** — MVP is hand-curated 5 markets, but W6+ of MM plan uses `poly_wallet_trades` aggregate volume per condition_id as an input to an automated market-selection scoring function.

## Build sequence

1. **W1: Contract discovery + schema migration.** Identify + verify live Polymarket contract addresses on Polygon. Ship the 5 new tables + 2 materialized views in a single migration. No ingestion yet.
2. **W2: Historical backfill runner.** Subgraph-first backfill + RPC verification for `poly_wallet_trades`. Full catchup to current head.
3. **W3: Live tail with reorg handling.** WS subscribe + idempotent insert with confirmation-delay mechanism. Reconcile every 10 minutes vs RPC head.
4. **W4: Position derivation + nightly stats.** Populate `poly_wallet_positions` from trades. Nightly batch populates `poly_wallet_stats`.
5. **W5: Sharp/degen classification + flow view.** Materialized views. 5-minute flow rollups. NOTIFY plumbing for MM consumption.

**Total:** 5 weeks focused, fully parallelizable with MM MVP weeks 1–5.

## Scaling & reliability

- **RPC reliability:** Public endpoints rate-limit and occasionally lag. Budget for paid Alchemy tier. Monitor lag with a synthetic "latest block we saw vs chain head" metric exposed on the admin HTTP server.
- **Event volume:** Polymarket sees ~50k trades/day peak. Annualized ≈15M rows/yr. Supabase handles this fine with the indexes above. Partition `poly_wallet_trades` by year at around the 2-year mark.
- **Reorg resilience:** 64-block confirmation window. No financial decisions are made on `final=false` rows (MM ignores flow-view rows from unconfirmed trades).
- **Wallet churn:** Some sharps rotate wallets. Out of scope for v1; v2 heuristic: cluster wallets by shared funding source (common on-chain funder address) + timing correlation.

## Deployment

New Fly.io app `pmci-poly-indexer`:
- Single instance (stateful — tracks `poly_indexer_cursor`)
- Low CPU, moderate memory (~1GB for WS + log parser)
- Writes to existing Supabase
- Restart-tolerant: resumes from `poly_indexer_cursor.last_block_number`
- Config: `deploy/fly.poly-indexer.toml`

Environment variables needed:
- `POLYGON_RPC_URL` — Alchemy or Infura endpoint
- `POLYGON_WS_URL` — WS endpoint for live tail
- `POLYMARKET_CTF_EXCHANGE_ADDR` — pinned contract address
- `POLYMARKET_CT_FRAMEWORK_ADDR` — pinned contract address
- `POLYMARKET_UMA_ADAPTER_ADDR` — pinned contract address

## Invariants

- **No Polymarket account is created or used. Ever.** No code path may sign a Polymarket API request with user credentials.
- **No trading of any kind** originates from this indexer or any module consuming its data. The indexer is write-disabled against exchange contracts; it can only read chain state.
- All financial decisions (MM quoting, market selection) consume only `final=true` rows. Unconfirmed data is informational-only.
- Contract addresses are pinned in a constants file and verified on startup against expected bytecode hashes. If a contract is upgraded or migrated, indexer halts until config is updated (fails safe).

## Open questions to resolve before W1

1. Which RPC provider? Alchemy vs Infura vs QuickNode — pick based on Polygon log-depth pricing.
2. Does Polymarket's subgraph expose everything we need, or will we still need raw RPC for certain derivations (e.g., UMA resolution events)? Verify before relying on subgraph for backfill.
3. What's the minimum `total_volume_usdc` threshold to include a wallet in the stats table at all? MVP suggestion: $100. Anything below is probably noise.
4. Do we care about off-Polymarket events affecting a wallet's funded balance (MEV bots, bridging)? Probably not for sharpness classification; realized P&L on Polymarket trades is the relevant number regardless.
