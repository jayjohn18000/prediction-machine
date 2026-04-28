-- Poly indexer W1 — raw trade storage, 5m flow rollups, dual-watermark cursor, resolutions.
-- Read-only Polygon observability; writer is future W2 Fly app. Service-role-only (Pre-W2 #3 pattern).

-- ---------------------------------------------------------------------------
-- pmci.poly_wallet_trades — partition by block_number (RANGE). Monthly splits TBD in ops.
-- UNIQUE must include partition key (PostgreSQL requirement); matches (tx_hash, log_index) per block.
-- ---------------------------------------------------------------------------
CREATE TABLE pmci.poly_wallet_trades (
  id              bigserial,
  block_number    bigint NOT NULL,
  block_hash      text NOT NULL,
  tx_hash         text NOT NULL,
  log_index       int NOT NULL,
  wallet_address  text NOT NULL,
  market_id       text NOT NULL,
  outcome_index   smallint NOT NULL,
  price_usdc      numeric(20, 6) NOT NULL,
  size_shares     numeric(30, 6) NOT NULL,
  side            text NOT NULL CHECK (side IN ('buy', 'sell')),
  final           boolean NOT NULL DEFAULT false,
  orphaned_at     timestamptz,
  observed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (block_number, id),
  UNIQUE (block_number, tx_hash, log_index)
) PARTITION BY RANGE (block_number);

CREATE INDEX idx_poly_wallet_trades_market_observed
  ON pmci.poly_wallet_trades (market_id, observed_at DESC);

COMMENT ON TABLE pmci.poly_wallet_trades IS
  'Polymarket CTF exchange trade rows (W1 schema). Partitioned by block_number. service_role only.';

CREATE TABLE pmci.poly_wallet_trades_p_init PARTITION OF pmci.poly_wallet_trades
  FOR VALUES FROM (MINVALUE) TO (MAXVALUE);

-- ---------------------------------------------------------------------------
-- pmci.poly_market_flow_5m — 5-minute buckets; PARTITION BY RANGE (bucket_start) weekly-sized span.
-- Rationale: query pattern is time-window scans per market; weekly partitions keep child table count small
-- (vs hour-of-day which would fan out unnecessarily on a single-clock table).
-- ---------------------------------------------------------------------------
CREATE TABLE pmci.poly_market_flow_5m (
  bucket_start      timestamptz NOT NULL,
  market_id         text NOT NULL,
  outcome_index     smallint NOT NULL,
  buy_count         bigint NOT NULL DEFAULT 0,
  sell_count        bigint NOT NULL DEFAULT 0,
  buy_usdc          numeric(30, 6) NOT NULL DEFAULT 0,
  sell_usdc         numeric(30, 6) NOT NULL DEFAULT 0,
  sharp_buy_count   bigint NOT NULL DEFAULT 0,
  sharp_sell_count  bigint NOT NULL DEFAULT 0,
  degen_buy_count   bigint NOT NULL DEFAULT 0,
  degen_sell_count  bigint NOT NULL DEFAULT 0,
  observed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market_id, outcome_index, bucket_start)
) PARTITION BY RANGE (bucket_start);

CREATE INDEX idx_poly_flow_market_bucket
  ON pmci.poly_market_flow_5m (market_id, bucket_start DESC);

COMMENT ON TABLE pmci.poly_market_flow_5m IS
  '5m flow rollup per (market_id, outcome_index). Partitioned by bucket_start (weekly partition span). service_role only.';

CREATE TABLE pmci.poly_market_flow_5m_p_init PARTITION OF pmci.poly_market_flow_5m
  FOR VALUES FROM ('1970-01-01'::timestamptz) TO (MAXVALUE);

-- ---------------------------------------------------------------------------
-- pmci.poly_indexer_cursor — dual watermark: speculative head vs post-confirmation final.
-- ---------------------------------------------------------------------------
CREATE TABLE pmci.poly_indexer_cursor (
  id                    int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  head_block_number     bigint NOT NULL,
  head_block_hash       text NOT NULL,
  final_block_number    bigint NOT NULL,
  final_block_hash      text NOT NULL,
  last_updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pmci.poly_indexer_cursor IS
  'Single-row cursor: head_* tracks live tip; final_* lags by confirmation depth (~64 blocks). service_role only.';

-- ---------------------------------------------------------------------------
-- pmci.poly_resolved_markets — UMA / adapter resolution pointers (filled in W2+).
-- ---------------------------------------------------------------------------
CREATE TABLE pmci.poly_resolved_markets (
  market_id                 text PRIMARY KEY,
  outcome_index_winner      smallint NOT NULL,
  resolution_block_number   bigint NOT NULL,
  resolution_tx_hash        text NOT NULL,
  observed_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_poly_resolved_block ON pmci.poly_resolved_markets (resolution_block_number DESC);

COMMENT ON TABLE pmci.poly_resolved_markets IS
  'Resolved Polymarket markets from on-chain/UMA signals. service_role only.';

-- ---------------------------------------------------------------------------
-- Privileges: REVOKE anon/authenticated; GRANT service_role + postgres
-- ---------------------------------------------------------------------------
REVOKE ALL ON pmci.poly_wallet_trades FROM PUBLIC;
REVOKE ALL ON pmci.poly_wallet_trades FROM anon;
REVOKE ALL ON pmci.poly_wallet_trades FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.poly_wallet_trades TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE pmci.poly_wallet_trades_id_seq TO service_role, postgres;

REVOKE ALL ON pmci.poly_market_flow_5m FROM PUBLIC;
REVOKE ALL ON pmci.poly_market_flow_5m FROM anon;
REVOKE ALL ON pmci.poly_market_flow_5m FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.poly_market_flow_5m TO service_role, postgres;

REVOKE ALL ON pmci.poly_indexer_cursor FROM PUBLIC;
REVOKE ALL ON pmci.poly_indexer_cursor FROM anon;
REVOKE ALL ON pmci.poly_indexer_cursor FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.poly_indexer_cursor TO service_role, postgres;

REVOKE ALL ON pmci.poly_resolved_markets FROM PUBLIC;
REVOKE ALL ON pmci.poly_resolved_markets FROM anon;
REVOKE ALL ON pmci.poly_resolved_markets FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.poly_resolved_markets TO service_role, postgres;
