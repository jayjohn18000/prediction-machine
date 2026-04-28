-- W2.2 — idempotent mm_fills ingest (Kalshi-native fill ids)
ALTER TABLE pmci.mm_fills
  ADD COLUMN IF NOT EXISTS kalshi_fill_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mm_fills_kalshi_fill_id_unique
  ON pmci.mm_fills (kalshi_fill_id)
  WHERE kalshi_fill_id IS NOT NULL;

COMMENT ON COLUMN pmci.mm_fills.kalshi_fill_id IS 'Kalshi fill_id from portfolio/fills API; used for INSERT idempotency.';
