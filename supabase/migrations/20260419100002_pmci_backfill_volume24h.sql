-- One-time backfill: copy latest non-null snapshot volume onto provider_markets when missing.
UPDATE pmci.provider_markets pm
SET volume_24h = s.vol
FROM (
  SELECT DISTINCT ON (provider_market_id)
    provider_market_id,
    volume_24h AS vol
  FROM pmci.provider_market_snapshots
  WHERE volume_24h IS NOT NULL
  ORDER BY provider_market_id, observed_at DESC
) s
WHERE pm.volume_24h IS NULL
  AND pm.id = s.provider_market_id;
