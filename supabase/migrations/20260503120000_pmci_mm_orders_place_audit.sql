-- MM PROD readiness: place-time book snapshot + rejection timing (orchestrator D).
-- Additive columns — apply after runtime code that populates them is deployed.

ALTER TABLE pmci.mm_orders
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS best_bid_cents_at_place integer,
  ADD COLUMN IF NOT EXISTS best_ask_cents_at_place integer,
  ADD COLUMN IF NOT EXISTS book_depth_at_place_jsonb jsonb,
  ADD COLUMN IF NOT EXISTS cancel_reason text;

COMMENT ON COLUMN pmci.mm_orders.rejected_at IS
  'Kalshi placement failure timestamp (terminal rejected status).';
COMMENT ON COLUMN pmci.mm_orders.best_bid_cents_at_place IS
  'Kalshi YES best bid in cents at quote submission.';
COMMENT ON COLUMN pmci.mm_orders.best_ask_cents_at_place IS
  'Kalshi YES best ask in cents at quote submission.';
COMMENT ON COLUMN pmci.mm_orders.book_depth_at_place_jsonb IS
  'Optional coarse book metadata (e.g. price_level_structure) at submission.';
COMMENT ON COLUMN pmci.mm_orders.cancel_reason IS
  'When set on cancel paths, human/machine reason for withdrawal.';
