-- W2.1 — MM write-side tables, kill-switch audit log, and provider_market_depth retention.
--
-- Audit: R2 (mm_market_config risk fields), R3 (no GENERATED adverse_cents_5m),
-- R10 (mm_kill_switch_events), R12 (mm_orders.market_id NOT NULL;
-- mm_pnl_snapshots UNIQUE (market_id, observed_at)), R13 (7-day depth prune cron).
--
-- Privileges: same service_role/postgres-only pattern as
-- 20260427120002_pmci_provider_market_depth_rls_lockdown.sql (Pre-W2 #3).
--
-- No mm_market_config seed rows (W3). No kalshi-trader code (W2.2).

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ---------------------------------------------------------------------------
-- pmci.mm_orders (R12: market_id NOT NULL)
-- ---------------------------------------------------------------------------
CREATE TABLE pmci.mm_orders (
  id                    bigserial PRIMARY KEY,
  market_id             bigint NOT NULL REFERENCES pmci.provider_markets (id),
  kalshi_order_id       text UNIQUE,
  client_order_id       text UNIQUE NOT NULL,
  side                  text NOT NULL CHECK (side IN ('yes_buy', 'yes_sell', 'no_buy', 'no_sell')),
  price_cents           int NOT NULL,
  size_contracts        int NOT NULL,
  status                text NOT NULL CHECK (status IN ('pending', 'open', 'filled', 'partial', 'cancelled', 'rejected')),
  placed_at             timestamptz NOT NULL,
  filled_at             timestamptz,
  fill_price_cents      int,
  fill_size_contracts   int,
  fair_value_at_place   numeric,
  payload               jsonb
);

CREATE INDEX idx_mm_orders_market_placed ON pmci.mm_orders (market_id, placed_at DESC);

COMMENT ON TABLE pmci.mm_orders IS
  'MM-placed Kalshi orders (all lifecycle states). Service-role only. market_id is required (R12).';

-- ---------------------------------------------------------------------------
-- pmci.mm_fills (R3: adverse_cents_5m is app-side, side-aware in W5 — not GENERATED)
-- ---------------------------------------------------------------------------
CREATE TABLE pmci.mm_fills (
  id                    bigserial PRIMARY KEY,
  order_id              bigint REFERENCES pmci.mm_orders (id) ON DELETE SET NULL,
  market_id             bigint NOT NULL REFERENCES pmci.provider_markets (id),
  observed_at           timestamptz NOT NULL,
  price_cents           int NOT NULL,
  size_contracts        int NOT NULL,
  side                  text NOT NULL CHECK (side IN ('yes_buy', 'yes_sell', 'no_buy', 'no_sell')),
  fair_value_at_fill    numeric NOT NULL,
  post_fill_mid_1m      numeric,
  post_fill_mid_5m      numeric,
  post_fill_mid_30m     numeric,
  adverse_cents_5m      numeric
);

CREATE INDEX idx_mm_fills_market_observed ON pmci.mm_fills (market_id, observed_at DESC);
CREATE INDEX idx_mm_fills_order_id ON pmci.mm_fills (order_id);

COMMENT ON TABLE pmci.mm_fills IS
  'MM fills with post-fill mid tracking. Service-role only.';

COMMENT ON COLUMN pmci.mm_fills.adverse_cents_5m IS
  'W5: populated application-side with side-aware semantics vs fair_value_at_fill (Contract R8). '
  'NOT a GENERATED column — naive (post_fill_mid_5m - fair_value_at_fill) is wrong for all NO-leg fills.';

-- ---------------------------------------------------------------------------
-- pmci.mm_positions
-- ---------------------------------------------------------------------------
CREATE TABLE pmci.mm_positions (
  market_id             bigint PRIMARY KEY REFERENCES pmci.provider_markets (id),
  net_contracts         int NOT NULL DEFAULT 0,
  avg_cost_cents        numeric,
  realized_pnl_cents    numeric DEFAULT 0,
  unrealized_pnl_cents  numeric,
  last_updated          timestamptz NOT NULL
);

COMMENT ON TABLE pmci.mm_positions IS 'Per-market MM position rollup. Service-role only.';

-- ---------------------------------------------------------------------------
-- pmci.mm_pnl_snapshots (R12: UNIQUE(market_id, observed_at))
-- ---------------------------------------------------------------------------
CREATE TABLE pmci.mm_pnl_snapshots (
  id                          bigserial PRIMARY KEY,
  market_id                   bigint NOT NULL REFERENCES pmci.provider_markets (id),
  observed_at                 timestamptz NOT NULL,
  spread_capture_cents        numeric,
  adverse_selection_cents     numeric,
  inventory_drift_cents       numeric,
  fees_cents                  numeric,
  net_pnl_cents               numeric,
  UNIQUE (market_id, observed_at)
);

CREATE INDEX idx_mm_pnl_snapshots_market_observed ON pmci.mm_pnl_snapshots (market_id, observed_at DESC);

COMMENT ON TABLE pmci.mm_pnl_snapshots IS
  'Attribution snapshots (Contract R7). One row per (market, bucket). Service-role only.';

-- ---------------------------------------------------------------------------
-- pmci.mm_market_config (R2: added risk / quoting fields)
-- ---------------------------------------------------------------------------
CREATE TABLE pmci.mm_market_config (
  market_id                       bigint PRIMARY KEY REFERENCES pmci.provider_markets (id),
  enabled                         boolean NOT NULL DEFAULT false,
  soft_position_limit             int NOT NULL,
  hard_position_limit             int NOT NULL,
  min_half_spread_cents           int NOT NULL,
  base_size_contracts             int NOT NULL,
  k_vol                           numeric NOT NULL DEFAULT 1.0,
  kill_switch_active              boolean NOT NULL DEFAULT false,
  last_toxicity_score             numeric,
  notes                           text,
  max_order_notional_cents        bigint NOT NULL,
  min_requote_cents               int NOT NULL,
  stale_quote_timeout_seconds     int NOT NULL,
  daily_loss_limit_cents          bigint NOT NULL
);

COMMENT ON TABLE pmci.mm_market_config IS
  'Hand-curated per-market MM parameters (W3 seeds). Service-role only. Includes R2 risk/quote limits.';

COMMENT ON COLUMN pmci.mm_market_config.max_order_notional_cents IS
  'Invariant: price_cents * size_contracts must not exceed this (plan §Invariants).';
COMMENT ON COLUMN pmci.mm_market_config.min_requote_cents IS
  'Quoting engine: skip repost if change is within this band vs working quote.';
COMMENT ON COLUMN pmci.mm_market_config.stale_quote_timeout_seconds IS
  'Risk: cancel working quotes if no fresh mid/depth within this window.';
COMMENT ON COLUMN pmci.mm_market_config.daily_loss_limit_cents IS
  'Portfolio or per-market daily loss cap for kill-switch (interpretation in risk module).';

-- ---------------------------------------------------------------------------
-- pmci.mm_kill_switch_events (R10: audit log)
-- ---------------------------------------------------------------------------
CREATE TABLE pmci.mm_kill_switch_events (
  id                bigserial PRIMARY KEY,
  observed_at       timestamptz NOT NULL DEFAULT now(),
  market_id         bigint REFERENCES pmci.provider_markets (id),
  reason            text NOT NULL,
  details           jsonb
);

CREATE INDEX idx_mm_kill_switch_market_observed ON pmci.mm_kill_switch_events (market_id, observed_at DESC);

COMMENT ON TABLE pmci.mm_kill_switch_events IS
  'Append-only audit of kill-switch and related safety events (R10). market_id NULL = global/portfolio scope. Service-role only.';

-- ---------------------------------------------------------------------------
-- R13 — 7-day retention for pmci.provider_market_depth
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
  'pmci-prune-provider-market-depth',
  '0 4 * * *',
  $$
    DELETE FROM pmci.provider_market_depth
    WHERE observed_at < NOW() - INTERVAL '7 days';
  $$
);

-- ---------------------------------------------------------------------------
-- Privileges: REVOKE anon/authenticated; GRANT service_role + postgres
-- ---------------------------------------------------------------------------
REVOKE ALL ON pmci.mm_orders FROM PUBLIC;
REVOKE ALL ON pmci.mm_orders FROM anon;
REVOKE ALL ON pmci.mm_orders FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.mm_orders TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE pmci.mm_orders_id_seq TO service_role, postgres;

REVOKE ALL ON pmci.mm_fills FROM PUBLIC;
REVOKE ALL ON pmci.mm_fills FROM anon;
REVOKE ALL ON pmci.mm_fills FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.mm_fills TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE pmci.mm_fills_id_seq TO service_role, postgres;

REVOKE ALL ON pmci.mm_positions FROM PUBLIC;
REVOKE ALL ON pmci.mm_positions FROM anon;
REVOKE ALL ON pmci.mm_positions FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.mm_positions TO service_role, postgres;

REVOKE ALL ON pmci.mm_pnl_snapshots FROM PUBLIC;
REVOKE ALL ON pmci.mm_pnl_snapshots FROM anon;
REVOKE ALL ON pmci.mm_pnl_snapshots FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.mm_pnl_snapshots TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE pmci.mm_pnl_snapshots_id_seq TO service_role, postgres;

REVOKE ALL ON pmci.mm_market_config FROM PUBLIC;
REVOKE ALL ON pmci.mm_market_config FROM anon;
REVOKE ALL ON pmci.mm_market_config FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.mm_market_config TO service_role, postgres;

REVOKE ALL ON pmci.mm_kill_switch_events FROM PUBLIC;
REVOKE ALL ON pmci.mm_kill_switch_events FROM anon;
REVOKE ALL ON pmci.mm_kill_switch_events FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.mm_kill_switch_events TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE pmci.mm_kill_switch_events_id_seq TO service_role, postgres;
