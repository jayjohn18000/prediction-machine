-- Lock down pmci schema: PostgREST should not expose PMCI tables to anon/authenticated.
-- API and Edge Functions use service_role / direct Postgres connections.

REVOKE ALL ON ALL TABLES IN SCHEMA pmci FROM anon;
REVOKE ALL ON ALL TABLES IN SCHEMA pmci FROM authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA pmci FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA pmci FROM authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pmci FROM anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pmci FROM authenticated;

-- Ensure service role retains full access (Supabase server-side clients).
GRANT USAGE ON SCHEMA pmci TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA pmci TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pmci TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pmci TO service_role;

-- Migration / admin connections often use postgres.
GRANT USAGE ON SCHEMA pmci TO postgres;
GRANT ALL ON ALL TABLES IN SCHEMA pmci TO postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pmci TO postgres;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pmci TO postgres;
