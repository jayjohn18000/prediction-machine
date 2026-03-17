-- Removal tracking for market_links: timestamp + reason taxonomy.
-- Backfills removed_at from updated_at for existing removed rows (best approximation).

ALTER TABLE pmci.market_links
  ADD COLUMN IF NOT EXISTS removed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS removed_reason text;

-- Backfill: for rows already soft-deleted, updated_at is the closest proxy
UPDATE pmci.market_links
SET removed_at = updated_at
WHERE status = 'removed' AND removed_at IS NULL;

-- Index for status-filtered historical queries
CREATE INDEX IF NOT EXISTS idx_pmci_market_links_status_updated
  ON pmci.market_links(status, updated_at DESC);
