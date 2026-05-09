-- Stream A Phase 0: scanner reference catalog (scanner-plan-v1 §8).
-- Seeds measured_variables + source_chains referenced by hypotheses and normalizers.

-- ============================================================================
-- REFERENCE: source chains
-- ============================================================================
CREATE TABLE pmci.source_chains (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_event     text NOT NULL,
  public_source   text NOT NULL,
  ingestion       text NOT NULL,
  detection       text NOT NULL,
  version         text NOT NULL,
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),
  hit_count       int NOT NULL DEFAULT 0,
  miss_count      int NOT NULL DEFAULT 0,
  hit_rate_30d    numeric(5,4),
  hit_rate_ci_low numeric(5,4),
  hit_rate_ci_high numeric(5,4),
  UNIQUE (world_event, public_source, ingestion, detection, version)
);

COMMENT ON TABLE pmci.source_chains IS 'Registered provenance chains (world→source→ingestion→detection→version); scanner + MM consumers.';

CREATE TABLE pmci.measured_variables (
  id              text PRIMARY KEY,
  display_name    text NOT NULL,
  description     text NOT NULL,
  namespace       text NOT NULL,
  scope           text NOT NULL,
  unit            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pmci.measured_variables IS 'Compositor pivot: orthogonal edges net by measured_variable instance.';

-- ============================================================================
-- INEFFICIENCY ENUM (also used later by scanner_signal tables + VIEW)
-- ============================================================================
CREATE TYPE pmci.inefficiency_type AS ENUM (
  'informational_lag','structural','behavioral',
  'analytical','capacity','resolution_rule'
);

-- ============================================================================
-- SEED measured_variables (hypothesis-tracker-template §9 + v1.5 placeholders)
-- ============================================================================
INSERT INTO pmci.measured_variables (id, display_name, description, namespace, scope, unit) VALUES
  ('nba_player_team_win_probability','NBA implied team/player win probability',
   'Late-game WPA-weighted divergence between external fair WP estimate and consensus mid.',
   'nba','strategy','pct'),
  ('maker_taker_gap_pct','Kalshi maker vs taker realized yield gap',
   'Structural wedge between maker rebates and adverse taker settlements (Whelan-style bands).',
   'kalshi','strategy','pct'),
  ('behavioral_overconfidence','Retail overconfidence curvature (PLACEHOLDER)',
   'Reserved v1.5: cross-pattern behavioral curvature vs baseline.',
   'cross_venue','strategy',NULL),
  ('analytical_pinnacle_divergence','Sharp vs consensus fair value (PLACEHOLDER)',
   'Reserved v1.5: Pinnacle / OddsAPI benchmark divergence.',
   'external_odds','strategy','cents'),
  ('capacity_book_depth','Book depth usable size at top of book (PLACEHOLDER)',
   'Reserved v1.5: liquidity / capacity constraint observable.',
   'kalshi','microstructure','contracts');

-- ============================================================================
-- SEED source_chains (H-2026-001 NBA + Whelan Track A + microstructure Track B)
-- ============================================================================
INSERT INTO pmci.source_chains (
  id, world_event, public_source, ingestion, detection, version
) VALUES (
  'aaaa1111-e89b-12d3-a456-426614174000'::uuid,
  'nba_high_wpa_play',
  'cdn.nba.com/static/json/liveData/playbyplay/playbyplay_{gameId}.json',
  'poll_3s',
  'wpa_p75_AND_mid_stable_30s_AND_diverge_3c',
  'v1'
), (
  'bbbb2222-e89b-12d3-a456-426614174001'::uuid,
  'kalshi_mm_trade_history_aggregate',
  'pmci.mm_fills (Kalshi transactional ledger)',
  'postgres_daily_read',
  'whelan_band_structural_daily_sql',
  'v1'
), (
  'cccc3333-e89b-12d3-a456-426614174002'::uuid,
  'kalshi_orderbook_microstructure_live',
  'Kalshi websocket orderbook_delta channels',
  'aws_ohio_normalizer_ws',
  'institutional_alpha_miner_port_v1',
  'v1'
);

-- ============================================================================
-- PRIVILEGES (match pmci MM tables pattern)
-- ============================================================================
REVOKE ALL ON pmci.source_chains FROM PUBLIC;
REVOKE ALL ON pmci.source_chains FROM anon;
REVOKE ALL ON pmci.source_chains FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.source_chains TO service_role, postgres;

REVOKE ALL ON pmci.measured_variables FROM PUBLIC;
REVOKE ALL ON pmci.measured_variables FROM anon;
REVOKE ALL ON pmci.measured_variables FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.measured_variables TO service_role, postgres;

REVOKE ALL ON TYPE pmci.inefficiency_type FROM PUBLIC;
GRANT USAGE ON TYPE pmci.inefficiency_type TO postgres, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- VALIDATION (Pattern 4): run manually after migrate; echoed here for auditors.
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='pmci' AND table_name IN ('source_chains','measured_variables');
-- SELECT COUNT(*) FROM pmci.measured_variables;  -- expect 5
-- SELECT COUNT(*) FROM pmci.source_chains WHERE id IN (
--   'aaaa1111-e89b-12d3-a456-426614174000'::uuid,'bbbb2222-e89b-12d3-a456-426614174001'::uuid,'cccc3333-e89b-12d3-a456-426614174002'::uuid
-- ); -- expect 3
