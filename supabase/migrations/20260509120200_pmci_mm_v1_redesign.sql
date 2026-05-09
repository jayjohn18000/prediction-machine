-- Stream A Phase 0: MM runtime v1 schema add-ons (mm-runtime-redesign-v2 §7 + mm_orders/mm_pnl/marks)
-- Plus mm_fills settlement columns aligned with scanner structural Track A SQL.

-- ============================================================================
-- VPIN / protection state / GM posterior (GM empty until Stream D runtime)
-- ============================================================================
CREATE TABLE pmci.mm_vpin_state (
  market_ticker   text PRIMARY KEY,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  vpin_value      numeric(5,4) NOT NULL,
  bucket_size_c   int NOT NULL,
  window_buckets  int NOT NULL,
  is_pulled       boolean NOT NULL DEFAULT false,
  pulled_until    timestamptz
);

CREATE TABLE pmci.mm_protection_state (
  id              bigserial PRIMARY KEY,
  protection_name text NOT NULL,
  market_ticker   text,
  scope           text NOT NULL CHECK (scope IN ('global','per_market','per_side')),
  fired_at        timestamptz NOT NULL DEFAULT now(),
  reason          text NOT NULL,
  action          text NOT NULL CHECK (action IN ('halve_size','one_sided_flatten','halt','cooldown_10min')),
  expires_at      timestamptz,
  resolved_at     timestamptz
);

CREATE TABLE pmci.mm_gm_posterior_state (
  market_ticker   text PRIMARY KEY,
  delta           numeric(5,4) NOT NULL,
  mu              numeric(5,4) NOT NULL,
  fair_value      numeric(5,4) NOT NULL,
  last_fill_at    timestamptz,
  last_fill_side  text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- EXTENSIONS to existing MM config + ledger
-- ============================================================================
ALTER TABLE pmci.mm_orders
  ADD COLUMN mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live','paper')),
  ADD COLUMN hypothesis_id text REFERENCES pmci.hypotheses(id);

ALTER TABLE pmci.mm_pnl_snapshots
  ADD COLUMN mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live','paper')),
  ADD COLUMN hypothesis_id text REFERENCES pmci.hypotheses(id);

ALTER TABLE pmci.mm_market_config
  ADD COLUMN IF NOT EXISTS allowlist_categories text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS vpin_threshold numeric(4,3) DEFAULT 0.7,
  ADD COLUMN IF NOT EXISTS game_state_pull_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_drawdown_pct_global numeric(4,3) DEFAULT 0.03,
  ADD COLUMN IF NOT EXISTS cooldown_after_consecutive_same_side int DEFAULT 3,
  ADD COLUMN IF NOT EXISTS gm_posterior_enabled boolean DEFAULT false;

ALTER TABLE pmci.mm_fills
  ADD COLUMN IF NOT EXISTS entry_price numeric(5,4),
  ADD COLUMN IF NOT EXISTS was_maker boolean,
  ADD COLUMN IF NOT EXISTS settlement_outcome text CHECK (
    settlement_outcome IS NULL OR settlement_outcome IN ('yes','no','no_settle')),
  ADD COLUMN IF NOT EXISTS settled_value numeric(5,4);

COMMENT ON COLUMN pmci.mm_fills.entry_price IS 'Trade price as probability in [0,1]; mirrors price_cents/100.';
COMMENT ON COLUMN pmci.mm_fills.was_maker IS 'Kalshi rebate >0 implies maker; trade fee >0 implies taker; NULL pre fee tracking.';
COMMENT ON COLUMN pmci.mm_fills.settlement_outcome IS 'Canonical binary resolution from pmci.market_outcomes (yes/no/no_settle).';
COMMENT ON COLUMN pmci.mm_fills.settled_value IS 'Contract-side payoff in probability units for paired entry_price analytics.';

-- Backfill entry_price / was_maker
UPDATE pmci.mm_fills
   SET entry_price = price_cents::numeric / 100.0
 WHERE entry_price IS NULL;

UPDATE pmci.mm_fills
   SET was_maker = CASE
     WHEN kalshi_rebate_cents IS NOT NULL AND kalshi_rebate_cents > 0 THEN true
     WHEN kalshi_trade_fee_cents IS NOT NULL AND kalshi_trade_fee_cents > 0 THEN false
     ELSE NULL
   END
 WHERE was_maker IS NULL;

-- Backfill settlement from pmci.market_outcomes
-- Columns (verified live): winning_outcome, provider_market_id, resolved_at
UPDATE pmci.mm_fills f
   SET settlement_outcome = CASE
         WHEN mo.resolved_at IS NULL THEN 'no_settle'
         WHEN lower(trim(mo.winning_outcome)) IN ('yes','y','1') THEN 'yes'
         WHEN lower(trim(mo.winning_outcome)) IN ('no','n','0') THEN 'no'
         ELSE 'no_settle'
       END,
       settled_value = CASE
         WHEN mo.resolved_at IS NULL THEN NULL
         WHEN lower(trim(mo.winning_outcome)) IN ('yes','y','1')
              AND lower(trim(coalesce(f.side::text,''))) = 'yes' THEN 1.0::numeric
         WHEN lower(trim(mo.winning_outcome)) IN ('yes','y','1')
              AND lower(trim(coalesce(f.side::text,''))) = 'no' THEN 0.0::numeric
         WHEN lower(trim(mo.winning_outcome)) IN ('no','n','0')
              AND lower(trim(coalesce(f.side::text,''))) = 'yes' THEN 0.0::numeric
         WHEN lower(trim(mo.winning_outcome)) IN ('no','n','0')
              AND lower(trim(coalesce(f.side::text,''))) = 'no' THEN 1.0::numeric
         ELSE NULL
       END
  FROM pmci.market_outcomes mo
 WHERE f.market_id = mo.provider_market_id
   AND f.settlement_outcome IS NULL;

-- ============================================================================
-- PRIVILEGES
-- ============================================================================
REVOKE ALL ON pmci.mm_vpin_state FROM PUBLIC;
REVOKE ALL ON pmci.mm_vpin_state FROM anon;
REVOKE ALL ON pmci.mm_vpin_state FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.mm_vpin_state TO service_role, postgres;

REVOKE ALL ON pmci.mm_protection_state FROM PUBLIC;
REVOKE ALL ON pmci.mm_protection_state FROM anon;
REVOKE ALL ON pmci.mm_protection_state FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.mm_protection_state TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE pmci.mm_protection_state_id_seq TO service_role, postgres;

REVOKE ALL ON pmci.mm_gm_posterior_state FROM PUBLIC;
REVOKE ALL ON pmci.mm_gm_posterior_state FROM anon;
REVOKE ALL ON pmci.mm_gm_posterior_state FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.mm_gm_posterior_state TO service_role, postgres;

-- ═══════════════════════════════════════════════════════════════════════════
-- VALIDATION (Pattern 4): evidence queries after migrate
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema='pmci' AND table_name='mm_fills'
--     AND column_name IN ('entry_price','was_maker','settlement_outcome','settled_value');
--
-- SELECT COUNT(*) AS fills_with_entry FROM pmci.mm_fills WHERE entry_price IS NOT NULL;
-- SELECT COUNT(*) AS fills_was_maker FROM pmci.mm_fills WHERE was_maker IS NOT NULL;
-- SELECT COUNT(*) AS fills_with_settlement FROM pmci.mm_fills WHERE settlement_outcome IS NOT NULL AND settlement_outcome <> 'no_settle';
--
-- ALTER visibility:
-- SELECT COUNT(*) FROM information_schema.columns
--  WHERE table_schema='pmci' AND table_name='mm_orders'
--    AND column_name IN ('mode','hypothesis_id');
