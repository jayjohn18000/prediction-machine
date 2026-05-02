-- ADR-011 cutover gate (defense-in-depth): close audit lane-05 BLOCKER on poly
-- partition children leaking SELECT to anon and authenticated.
--
-- Postgres partition CHILDREN do NOT inherit parent revocations. The ADR-009
-- migration revoked SELECT on the parent tables (poly_wallet_trades and
-- poly_market_flow_5m) but the auto-created _p_init partition children retained
-- the default `GRANT SELECT TO anon` baked into Supabase's role defaults.
--
-- Currently harmless (tables empty); becomes a hard data leak the moment W2
-- ingestion starts. Same revoke for any future partition children added by
-- declarative monthly-partition rolls.
--
-- Also enables explicit RLS on cash-touching MM tables — they are already
-- service-role-only by grant absence, but explicit RLS is defense-in-depth
-- (lane-05 DEGRADER recommendation).

-- 1) Revoke from anon/authenticated on existing poly partition children.
DO $$
DECLARE
  v_child TEXT;
BEGIN
  FOR v_child IN
    SELECT child.relname
    FROM pg_inherits inh
    JOIN pg_class child ON child.oid = inh.inhrelid
    JOIN pg_class parent ON parent.oid = inh.inhparent
    WHERE parent.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'pmci')
      AND parent.relname IN ('poly_wallet_trades', 'poly_market_flow_5m')
  LOOP
    EXECUTE format('REVOKE ALL ON pmci.%I FROM anon, authenticated', v_child);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.%I TO service_role', v_child);
    RAISE NOTICE 'revoked anon/authenticated on pmci.%', v_child;
  END LOOP;
END$$;

-- 2) Default-grant guard for FUTURE partition children attached to these parents.
ALTER DEFAULT PRIVILEGES IN SCHEMA pmci REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA pmci GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;

-- 3) Enable explicit RLS on cash-touching MM tables (defense-in-depth on top of
--    grant absence). With no policies, any role except `service_role` (BYPASSRLS)
--    is denied even SELECT.
ALTER TABLE pmci.mm_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE pmci.mm_orders FORCE ROW LEVEL SECURITY;

ALTER TABLE pmci.mm_fills ENABLE ROW LEVEL SECURITY;
ALTER TABLE pmci.mm_fills FORCE ROW LEVEL SECURITY;

ALTER TABLE pmci.mm_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pmci.mm_positions FORCE ROW LEVEL SECURITY;

ALTER TABLE pmci.mm_pnl_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE pmci.mm_pnl_snapshots FORCE ROW LEVEL SECURITY;

ALTER TABLE pmci.mm_kill_switch_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pmci.mm_kill_switch_events FORCE ROW LEVEL SECURITY;

ALTER TABLE pmci.mm_market_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE pmci.mm_market_config FORCE ROW LEVEL SECURITY;

ALTER TABLE pmci.provider_market_depth ENABLE ROW LEVEL SECURITY;
ALTER TABLE pmci.provider_market_depth FORCE ROW LEVEL SECURITY;

-- 4) Validation. Run after migration:
--   SELECT n.nspname, c.relname,
--          relrowsecurity AS rls_on,
--          relforcerowsecurity AS rls_forced
--   FROM pg_class c
--   JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'pmci'
--     AND c.relname IN ('mm_orders','mm_fills','mm_positions','mm_pnl_snapshots',
--                       'mm_kill_switch_events','mm_market_config','provider_market_depth')
--   ORDER BY c.relname;
-- Expected: rls_on = true AND rls_forced = true on every row.
--
-- Privilege validation (no anon SELECT on poly partitions):
--   SELECT grantee, table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_schema = 'pmci'
--     AND table_name LIKE 'poly_%_p_%'
--     AND grantee IN ('anon', 'authenticated');
-- Expected: zero rows.
