-- Phase E1.1 follow-on: snapshot retention policy
-- Prevents unbounded growth of provider_market_snapshots (hit 500MB free tier limit)
-- Requires pg_cron extension (available on Supabase Pro)
-- Before applying: enable pg_cron via Supabase Dashboard → Database → Extensions

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Delete snapshots older than 30 days, run nightly at 3am UTC
SELECT cron.schedule(
  'pmci-snapshot-retention',
  '0 3 * * *',
  $$
    DELETE FROM pmci.provider_market_snapshots
    WHERE observed_at < NOW() - INTERVAL '30 days';
  $$
);

COMMENT ON EXTENSION pg_cron IS 'Job scheduler for PostgreSQL — used by PMCI snapshot retention';