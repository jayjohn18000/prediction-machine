-- Grant DML on pmci.provider_market_depth to match existing pmci.provider_markets and
-- pmci.provider_market_snapshots privilege patterns. The original 20260424120004
-- migration was applied without grants; this follow-up adds them.
--
-- Verified via information_schema.role_table_grants: provider_markets and
-- provider_market_snapshots have INSERT,SELECT,UPDATE,DELETE for anon, authenticated,
-- and service_role. We mirror the same pattern here for write parity.

GRANT INSERT, SELECT, UPDATE, DELETE ON pmci.provider_market_depth TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE pmci.provider_market_depth_id_seq TO anon, authenticated, service_role;
