-- Lock down pmci.provider_market_depth: revoke W1 anon+authenticated grants
-- (per audit Group B / agent 05 §3.1). This is the precedent pattern that
-- ALL mm_* and poly_wallet_* tables MUST inherit in W2.

REVOKE ALL ON pmci.provider_market_depth FROM PUBLIC;
REVOKE ALL ON pmci.provider_market_depth FROM anon;
REVOKE ALL ON pmci.provider_market_depth FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.provider_market_depth TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE pmci.provider_market_depth_id_seq TO service_role, postgres;

COMMENT ON TABLE pmci.provider_market_depth IS
  'Kalshi L2 order-book snapshots, 1Hz downsampled. Populated by lib/ingestion/depth.mjs (MM MVP W1). Kalshi sends YES-bid and NO-bid ladders; YES-ask is derived as 100 - best_no_bid. Service-role-only (no anon/authenticated access) — this is the trading-data RLS precedent that mm_* and poly_wallet_* tables MUST inherit in W2.';
