-- Stream A Phase 0: scanner core DDL (hypotheses, per-type signals, compositor,
-- allocator, decay, alerts+trigger, unified view, backtest tables).

-- Bridge join (resolver): new scanner rows use market_ticker text while MM FK uses
-- bigint market_id → join path:
--   pmci.scanner_*_signals.market_ticker = pmci.provider_markets.market_ticker (Kalshi ticker in provider_market_ref)
--   ↔ pmci.provider_markets.id = pmci.mm_orders.market_id .

-- ============================================================================
-- HYPOTHESES
-- ============================================================================
CREATE TABLE pmci.hypotheses (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN (
                    'proposed','scanning','testing','live','retired')),
  inefficiency_type pmci.inefficiency_type NOT NULL,
  measured_variable text NOT NULL REFERENCES pmci.measured_variables(id),
  edge_direction  text NOT NULL CHECK (edge_direction IN ('bullish_yes','bearish_yes','neutral')),
  edge_magnitude_c numeric(6,2) NOT NULL,
  confidence      numeric(4,3) NOT NULL,
  applies_when    jsonb NOT NULL DEFAULT '{}'::jsonb,
  invalidated_by  text[] NOT NULL DEFAULT '{}',
  ttl_seconds     int,
  expected_trades_per_day numeric(8,2),
  expected_edge_per_trade_c numeric(6,2),
  min_position_size_c int NOT NULL DEFAULT 500,
  max_position_size_c int NOT NULL DEFAULT 5000,
  avg_position_hold_seconds int,
  max_concurrent_positions int NOT NULL DEFAULT 1,
  theoretical_daily_pnl_c numeric(10,2) GENERATED ALWAYS AS (
    expected_trades_per_day * expected_edge_per_trade_c * (max_position_size_c::numeric / 100)
  ) STORED,
  mechanism_md    text NOT NULL,
  source_chain_id uuid NOT NULL REFERENCES pmci.source_chains(id),
  entry_rules     jsonb NOT NULL,
  exit_rules      jsonb NOT NULL,
  sizing_rules    jsonb NOT NULL,
  risk_gates      jsonb NOT NULL,
  falsification_test text NOT NULL,
  feature_importance jsonb,
  feature_importance_method text DEFAULT 'logistic_regression_perm',
  feature_importance_n int NOT NULL DEFAULT 0,
  feature_importance_updated_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  promoted_at     timestamptz,
  retired_at      timestamptz,
  retired_reason  text,
  realized_pnl_cents numeric(10,2) NOT NULL DEFAULT 0,
  last_validated_at timestamptz
);

CREATE INDEX hypotheses_status_idx ON pmci.hypotheses(status);
CREATE INDEX hypotheses_measured_variable_idx ON pmci.hypotheses(measured_variable);

-- ============================================================================
-- PER-TYPE SIGNAL TABLES (six lanes; placeholders clone informational_lag skeleton)
-- ============================================================================

CREATE TABLE pmci.scanner_informational_lag_signals (
  signal_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observed_at     timestamptz NOT NULL DEFAULT now(),
  market_ticker   text NOT NULL,
  signal_strength_cents numeric(8,2) NOT NULL,
  source_chain_id uuid NOT NULL REFERENCES pmci.source_chains(id),
  hypothesis_id   text REFERENCES pmci.hypotheses(id),
  resolved_at     timestamptz,
  resolved_outcome text CHECK (resolved_outcome IN ('hit','miss','no_signal','timeout')),
  resolved_pnl_cents numeric(8,2),
  notes           jsonb NOT NULL DEFAULT '{}'::jsonb,
  game_id         text NOT NULL,
  period          int,
  game_clock_seconds_remaining int,
  event_type      text NOT NULL,
  wpa_at_event    numeric(6,4),
  wpa_percentile_30d numeric(5,2),
  pre_event_kalshi_mid numeric(5,4),
  post_event_kalshi_mid numeric(5,4),
  fair_wp_estimate numeric(5,4),
  divergence_at_t_plus_30s numeric(5,4),
  external_event_at timestamptz NOT NULL,
  kalshi_first_repriced_at timestamptz,
  lag_ms          bigint
);

CREATE TABLE pmci.scanner_structural_signals (
  signal_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observed_at     timestamptz NOT NULL DEFAULT now(),
  market_ticker   text NOT NULL,
  signal_strength_cents numeric(8,2) NOT NULL,
  source_chain_id uuid NOT NULL REFERENCES pmci.source_chains(id),
  hypothesis_id   text REFERENCES pmci.hypotheses(id),
  resolved_at     timestamptz,
  resolved_outcome text,
  resolved_pnl_cents numeric(8,2),
  notes           jsonb NOT NULL DEFAULT '{}'::jsonb,
  detector_track  text NOT NULL CHECK (detector_track IN ('whelan_band','microstructure')),
  price_band      text,
  side            text,
  trade_count     int,
  realized_yield_pct numeric(6,4),
  band_window_start timestamptz,
  band_window_end timestamptz,
  microprice      numeric(6,5),
  imbalance_ratio numeric(5,4),
  spread_cents    numeric(5,2),
  momentum_signal numeric(6,5),
  confidence_score numeric(5,4)
);

CREATE TABLE pmci.scanner_behavioral_signals (LIKE pmci.scanner_informational_lag_signals INCLUDING ALL);
CREATE TABLE pmci.scanner_analytical_signals (LIKE pmci.scanner_informational_lag_signals INCLUDING ALL);
CREATE TABLE pmci.scanner_capacity_signals (LIKE pmci.scanner_informational_lag_signals INCLUDING ALL);
CREATE TABLE pmci.scanner_resolution_rule_signals (LIKE pmci.scanner_informational_lag_signals INCLUDING ALL);

-- ============================================================================
-- COMPOSITOR + STRATEGY AGGREGATOR + PORTFOLIO ALLOCATOR
-- ============================================================================
CREATE TABLE pmci.market_signals (
  id              bigserial PRIMARY KEY,
  market_ticker   text NOT NULL,
  snapshot_ts     timestamptz NOT NULL,
  active_hypothesis_ids text[] NOT NULL,
  net_edge_c      numeric(6,2) NOT NULL,
  conflict_flag   boolean NOT NULL DEFAULT false,
  dominant_inefficiency_type pmci.inefficiency_type,
  dominant_hypothesis_id text REFERENCES pmci.hypotheses(id),
  confidence_composite numeric(4,3),
  UNIQUE (market_ticker, snapshot_ts)
);

CREATE TABLE pmci.hypothesis_capacity_state (
  hypothesis_id   text PRIMARY KEY REFERENCES pmci.hypotheses(id),
  computed_at     timestamptz NOT NULL DEFAULT now(),
  observed_trades_30d int NOT NULL,
  realized_edge_per_trade_c_30d numeric(6,2),
  realized_hold_seconds_p50 int,
  capacity_adjusted_daily_pnl_c numeric(10,2),
  capacity_ceiling_c numeric(10,2)
);

CREATE TABLE pmci.portfolio_allocations (
  id              bigserial PRIMARY KEY,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  total_capital_c bigint NOT NULL,
  hypothesis_id   text NOT NULL REFERENCES pmci.hypotheses(id),
  allocated_capital_c bigint NOT NULL,
  allocation_reason text NOT NULL,
  active_until    timestamptz
);

-- ============================================================================
-- DECAY MONITOR
-- ============================================================================
CREATE TABLE pmci.hypothesis_decay_state (
  hypothesis_id   text PRIMARY KEY REFERENCES pmci.hypotheses(id),
  ref_window_start timestamptz NOT NULL,
  ref_window_end  timestamptz NOT NULL,
  current_window_start timestamptz NOT NULL,
  current_window_end timestamptz NOT NULL,
  psi_per_feature jsonb NOT NULL,
  ks_per_feature  jsonb NOT NULL,
  weighted_drift  numeric(6,4) NOT NULL,
  streaming_kswin_alarm boolean NOT NULL DEFAULT false,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  triggers_retire boolean GENERATED ALWAYS AS (weighted_drift > 0.2 OR streaming_kswin_alarm) STORED
);

-- ============================================================================
-- ALERTS — FK trigger-gated to live hypotheses
-- ============================================================================
CREATE TABLE pmci.alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fired_at        timestamptz NOT NULL DEFAULT now(),
  hypothesis_id   text NOT NULL REFERENCES pmci.hypotheses(id),
  signal_id       uuid NOT NULL,
  signal_type     text NOT NULL,
  message         text NOT NULL,
  webhook_target  text NOT NULL,
  tradable        boolean NOT NULL,
  current_allocation_c bigint,
  delivered_at    timestamptz,
  delivery_status text
);

CREATE OR REPLACE FUNCTION pmci.enforce_alerts_live_only() RETURNS trigger AS $$
DECLARE h_status text;
BEGIN
  SELECT status INTO h_status FROM pmci.hypotheses WHERE id = NEW.hypothesis_id;
  IF h_status IS DISTINCT FROM 'live' THEN
    RAISE EXCEPTION 'alerts can only reference hypotheses with status=live, got %', h_status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER alerts_live_only_trg
  BEFORE INSERT ON pmci.alerts
  FOR EACH ROW EXECUTE FUNCTION pmci.enforce_alerts_live_only();

-- ============================================================================
-- BACKTEST INFRASTRUCTURE (three-stage flow placeholders)
-- ============================================================================
CREATE TABLE pmci.backtest_runs (
  id              bigserial PRIMARY KEY,
  hypothesis_id   text NOT NULL REFERENCES pmci.hypotheses(id),
  market_ticker   text NOT NULL,
  start_at        timestamptz NOT NULL,
  end_at          timestamptz NOT NULL,
  params_snapshot jsonb NOT NULL,
  spread_capture_c numeric(10,2),
  adverse_c       numeric(10,2),
  fee_net_c       numeric(10,2),
  fill_rate       numeric(5,4),
  n_quotes        int,
  n_fills         int,
  computed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pmci.backtest_fills (
  id              bigserial PRIMARY KEY,
  run_id          bigint NOT NULL REFERENCES pmci.backtest_runs(id),
  snapshot_ts     timestamptz NOT NULL,
  side            text NOT NULL,
  price           numeric(5,4) NOT NULL,
  size_c          int NOT NULL,
  fill_type       text NOT NULL,
  pnl_c           numeric(8,2)
);

-- ============================================================================
-- UNIFIED VIEW (v1 unions informational_lag + structural only)
-- ============================================================================
CREATE VIEW pmci.scanner_signals_unified AS
  SELECT signal_id, observed_at, market_ticker, signal_strength_cents,
         source_chain_id, hypothesis_id, 'informational_lag'::pmci.inefficiency_type AS type,
         resolved_at, resolved_outcome::text AS resolved_outcome, resolved_pnl_cents
    FROM pmci.scanner_informational_lag_signals
  UNION ALL
  SELECT signal_id, observed_at, market_ticker, signal_strength_cents,
         source_chain_id, hypothesis_id, 'structural'::pmci.inefficiency_type AS type,
         resolved_at, resolved_outcome::text AS resolved_outcome, resolved_pnl_cents
    FROM pmci.scanner_structural_signals;

COMMENT ON VIEW pmci.scanner_signals_unified IS
  'v1 union of active lanes only; extend with behavioral/analytical/capacity/resolution_rule in v1.5';

-- ============================================================================
-- PRIVILEGES
-- ============================================================================
DO $grants$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT unnest(ARRAY[
    'hypotheses',
    'scanner_informational_lag_signals',
    'scanner_structural_signals',
    'scanner_behavioral_signals',
    'scanner_analytical_signals',
    'scanner_capacity_signals',
    'scanner_resolution_rule_signals',
    'market_signals',
    'hypothesis_capacity_state',
    'portfolio_allocations',
    'hypothesis_decay_state',
    'alerts',
    'backtest_runs',
    'backtest_fills'
  ]::text[]) AS tbl
  LOOP
    EXECUTE format('REVOKE ALL ON pmci.%I FROM PUBLIC', r.tbl);
    EXECUTE format('REVOKE ALL ON pmci.%I FROM anon', r.tbl);
    EXECUTE format('REVOKE ALL ON pmci.%I FROM authenticated', r.tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.%I TO service_role, postgres', r.tbl);
  END LOOP;
END
$grants$;

GRANT USAGE, SELECT ON SEQUENCE pmci.market_signals_id_seq TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE pmci.portfolio_allocations_id_seq TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE pmci.backtest_runs_id_seq TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE pmci.backtest_fills_id_seq TO service_role, postgres;

REVOKE ALL ON TABLE pmci.scanner_signals_unified FROM PUBLIC;
REVOKE ALL ON TABLE pmci.scanner_signals_unified FROM anon;
REVOKE ALL ON TABLE pmci.scanner_signals_unified FROM authenticated;
GRANT SELECT ON TABLE pmci.scanner_signals_unified TO service_role, postgres;

-- ═══════════════════════════════════════════════════════════════════════════
-- VALIDATION (Pattern 4): manual checklist after migrate + trigger smoke.
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT COUNT(*) FROM information_schema.tables
--   WHERE table_schema='pmci' AND table_name LIKE 'scanner\_%' ESCAPE '\' ;  -- expect 6
-- SELECT COUNT(*) FROM information_schema.views WHERE table_schema='pmci' AND table_name='scanner_signals_unified';
--
-- Negative test — must ERROR (hypothesis absent):
-- INSERT INTO pmci.alerts (
--   hypothesis_id, signal_id, signal_type, message, webhook_target, tradable
-- ) VALUES (
--   'H-NONEXIST','00000000-0000-0000-0000-000000000000'::uuid,'test','x','hooks.slack.local',false
-- );
