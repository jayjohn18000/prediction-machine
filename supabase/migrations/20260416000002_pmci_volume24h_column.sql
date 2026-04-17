-- Add volume_24h to provider_markets for direct queryability without snapshot joins
ALTER TABLE pmci.provider_markets
  ADD COLUMN IF NOT EXISTS volume_24h numeric(20,4);

-- Index for ranking queries
CREATE INDEX IF NOT EXISTS idx_provider_markets_volume_24h
  ON pmci.provider_markets (volume_24h DESC NULLS LAST)
  WHERE volume_24h IS NOT NULL;

COMMENT ON COLUMN pmci.provider_markets.volume_24h IS
  'Rolling 24h trading volume from provider API, updated on every ingest upsert.';
