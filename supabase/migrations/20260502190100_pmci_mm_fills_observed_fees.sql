-- ADR-011 cutover gate 3: fee model within 2% of Kalshi statement.
--
-- The lane-13 audit established that pmci.mm_fills has no observed-fee column,
-- so post-cutover reconciliation against Kalshi's monthly statement has no LHS.
-- This migration adds four observed-fee columns. The writer in
-- lib/mm/ingest-fills.mjs is updated in the same PR to populate them when
-- Kalshi's fill payload includes the fields; nullable for backward-compat.

ALTER TABLE pmci.mm_fills
  ADD COLUMN IF NOT EXISTS kalshi_trade_fee_cents NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS kalshi_rounding_fee_cents NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS kalshi_rebate_cents NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS kalshi_net_fee_cents NUMERIC(12, 4);

COMMENT ON COLUMN pmci.mm_fills.kalshi_trade_fee_cents IS
  'Observed Kalshi trade fee in cents (centi-cent precision). NULL when ingest predates ADR-011 or Kalshi did not return the field.';
COMMENT ON COLUMN pmci.mm_fills.kalshi_rounding_fee_cents IS
  'Observed Kalshi rounding fee in cents. NULL when ingest predates ADR-011.';
COMMENT ON COLUMN pmci.mm_fills.kalshi_rebate_cents IS
  'Observed Kalshi rebate (positive = rebate received). NULL when ingest predates ADR-011.';
COMMENT ON COLUMN pmci.mm_fills.kalshi_net_fee_cents IS
  'Net = trade_fee + rounding_fee - rebate. Used by the lane-13 reconciliation against monthly fee statements.';

-- Validation: confirm no existing rows broke. After deploying the writer,
-- query SELECT count(*) FILTER (WHERE kalshi_net_fee_cents IS NOT NULL) FROM pmci.mm_fills
-- and watch it grow as new fills land.
