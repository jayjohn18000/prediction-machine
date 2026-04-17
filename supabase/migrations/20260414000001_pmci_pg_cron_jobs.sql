-- PMCI Automation Sprint — pg_cron scheduled jobs
-- Requires: pg_cron extension (already enabled via 20260331000002)
-- Cadence rationale documented inline for each job
--
-- NOTE (2026-04-17): Supabase managed Postgres does not allow ALTER DATABASE/ROLE
-- to set custom parameters, so current_setting('app.*') always returns NULL.
-- All cron jobs use hardcoded URLs and keys instead.
-- Edge Function requires both Authorization: Bearer <anon-key> (gateway) and
-- x-pmci-api-key (app auth). Edge Function also requires body: JSON.stringify({})
-- to satisfy Fastify's Content-Type: application/json requirement (fixed in v6).

-- -------------------------------------------------------
-- 1. SPORTS INGEST — every 4 hours
-- -------------------------------------------------------
SELECT cron.schedule(
  'pmci-ingest-sports',
  '0 */4 * * *',
  $$
    SELECT net.http_post(
      url := 'https://awueugxrdlolzjzikero.supabase.co/functions/v1/pmci-job-runner',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF3dWV1Z3hyZGxvbHpqemlrZXJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3OTAzNTEsImV4cCI6MjA4NzM2NjM1MX0.iFCMVUqrZf0Hfy3hG9tyarltFfl5pKsM2eNdblq5NYE","x-pmci-api-key":"VcrD2S8kTWLJpik4"}'::jsonb,
      body := '{"job":"ingest:sports"}'::jsonb
    );
  $$
);

-- -------------------------------------------------------
-- 2. POLITICS UNIVERSE INGEST — every 4 hours (offset by 2h from sports)
-- -------------------------------------------------------
SELECT cron.schedule(
  'pmci-ingest-politics',
  '0 2,6,10,14,18,22 * * *',
  $$
    SELECT net.http_post(
      url := 'https://awueugxrdlolzjzikero.supabase.co/functions/v1/pmci-job-runner',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF3dWV1Z3hyZGxvbHpqemlrZXJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3OTAzNTEsImV4cCI6MjA4NzM2NjM1MX0.iFCMVUqrZf0Hfy3hG9tyarltFfl5pKsM2eNdblq5NYE","x-pmci-api-key":"VcrD2S8kTWLJpik4"}'::jsonb,
      body := '{"job":"ingest:politics"}'::jsonb
    );
  $$
);

-- -------------------------------------------------------
-- 3. STALE CLEANUP — nightly at 2am UTC
-- -------------------------------------------------------
SELECT cron.schedule(
  'pmci-stale-cleanup',
  '0 2 * * *',
  $$
    SELECT net.http_post(
      url := 'https://awueugxrdlolzjzikero.supabase.co/functions/v1/pmci-job-runner',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF3dWV1Z3hyZGxvbHpqemlrZXJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3OTAzNTEsImV4cCI6MjA4NzM2NjM1MX0.iFCMVUqrZf0Hfy3hG9tyarltFfl5pKsM2eNdblq5NYE","x-pmci-api-key":"VcrD2S8kTWLJpik4"}'::jsonb,
      body := '{"job":"stale-cleanup"}'::jsonb
    );
  $$
);

-- -------------------------------------------------------
-- 4. SCHEMA VERIFICATION — daily at 6am UTC
-- -------------------------------------------------------
SELECT cron.schedule(
  'pmci-verify-schema',
  '0 6 * * *',
  $$
    SELECT net.http_post(
      url := 'https://awueugxrdlolzjzikero.supabase.co/functions/v1/pmci-job-runner',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF3dWV1Z3hyZGxvbHpqemlrZXJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3OTAzNTEsImV4cCI6MjA4NzM2NjM1MX0.iFCMVUqrZf0Hfy3hG9tyarltFfl5pKsM2eNdblq5NYE","x-pmci-api-key":"VcrD2S8kTWLJpik4"}'::jsonb,
      body := '{"job":"verify:schema"}'::jsonb
    );
  $$
);

-- -------------------------------------------------------
-- 5. DAILY AUDIT UMBRELLA — daily at 7am UTC
-- -------------------------------------------------------
SELECT cron.schedule(
  'pmci-audit-live',
  '0 7 * * *',
  $$
    SELECT net.http_post(
      url := 'https://awueugxrdlolzjzikero.supabase.co/functions/v1/pmci-job-runner',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF3dWV1Z3hyZGxvbHpqemlrZXJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3OTAzNTEsImV4cCI6MjA4NzM2NjM1MX0.iFCMVUqrZf0Hfy3hG9tyarltFfl5pKsM2eNdblq5NYE","x-pmci-api-key":"VcrD2S8kTWLJpik4"}'::jsonb,
      body := '{"job":"audit:live"}'::jsonb
    );
  $$
);
