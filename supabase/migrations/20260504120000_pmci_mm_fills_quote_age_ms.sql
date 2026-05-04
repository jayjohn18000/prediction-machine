-- MM quote staleness at fill time (ADR-012 clock-safe additive column).
ALTER TABLE pmci.mm_fills
  ADD COLUMN IF NOT EXISTS quote_age_ms_at_fill integer;

COMMENT ON COLUMN pmci.mm_fills.quote_age_ms_at_fill IS
  'Ms between parent mm_orders.placed_at and this fill observed_at (resting quote age when lifted).';
