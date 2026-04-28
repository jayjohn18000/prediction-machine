CREATE OR REPLACE VIEW pmci.v_polymarket_latest_prices AS
SELECT DISTINCT ON (s.provider_market_id)
  s.provider_market_id,
  s.observed_at,
  s.price_yes,
  s.best_bid_yes,
  s.best_ask_yes
FROM pmci.provider_market_snapshots s
JOIN pmci.provider_markets pm ON pm.id = s.provider_market_id
JOIN pmci.providers p         ON p.id = pm.provider_id
WHERE p.code = 'polymarket'
ORDER BY s.provider_market_id, s.observed_at DESC;

COMMENT ON VIEW pmci.v_polymarket_latest_prices IS
  'Latest Polymarket snapshot per provider_market_id. Consumed by MM W3 fair-value blend and Poly indexer reconciliation. Read-only; populated implicitly by the observer through pmci.provider_market_snapshots.';

REVOKE ALL ON pmci.v_polymarket_latest_prices FROM PUBLIC;
REVOKE ALL ON pmci.v_polymarket_latest_prices FROM anon, authenticated;
GRANT  SELECT ON pmci.v_polymarket_latest_prices TO service_role, postgres;
