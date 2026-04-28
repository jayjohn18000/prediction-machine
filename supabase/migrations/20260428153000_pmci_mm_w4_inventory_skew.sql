-- W4 — inventory skew v1 configuration (piecewise skew in quoting-engine).
ALTER TABLE pmci.mm_market_config
  ADD COLUMN IF NOT EXISTS inventory_skew_cents int NOT NULL DEFAULT 15;

COMMENT ON COLUMN pmci.mm_market_config.inventory_skew_cents IS
  'Max YES-price shift (cents) at |inventory| = hard; zero skew when |inv| <= soft; linear ramp between (W4 v1).';
