-- PMCI Automation Sprint — pg_cron scheduled jobs
-- Requires: pg_cron extension (already enabled via 20260331000002)
-- Cadence rationale documented inline for each job

-- -------------------------------------------------------
-- 1. SPORTS INGEST — every 4 hours
-- Replaces the Cowork "pmci-sports-ingest" scheduled task.
-- Keeps provider_markets and snapshots fresh for sports category.
-- -------------------------------------------------------
SELECT cron.schedule(
  'pmci-ingest-sports',
  '0 */4 * * *',
  $$
    SELECT net.http_post(
      url := current_setting('app.pmci_internal_trigger_url'),
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key')),
      body := '{"job":"ingest:sports"}'::jsonb
    );
  $$
);

-- -------------------------------------------------------
-- 2. POLITICS UNIVERSE INGEST — every 4 hours (offset by 2h from sports)
-- Parity with sports ingest. No equivalent was previously scheduled.
-- -------------------------------------------------------
SELECT cron.schedule(
  'pmci-ingest-politics',
  '0 2,6,10,14,18,22 * * *',
  $$
    SELECT net.http_post(
      url := current_setting('app.pmci_internal_trigger_url'),
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key')),
      body := '{"job":"ingest:politics"}'::jsonb
    );
  $$
);

-- -------------------------------------------------------
-- 3. STALE CLEANUP — nightly at 2am UTC
-- Critical missing job flagged in system-state.md.
-- Guard is baked into stale-cleanup.mjs (linked markets check).
-- Run at 2am (before snapshot retention at 3am) so stales are
-- cleared before the retention window computes.
-- -------------------------------------------------------
SELECT cron.schedule(
  'pmci-stale-cleanup',
  '0 2 * * *',
  $$
    SELECT net.http_post(
      url := current_setting('app.pmci_internal_trigger_url'),
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key')),
      body := '{"job":"stale-cleanup"}'::jsonb
    );
  $$
);

-- -------------------------------------------------------
-- 4. SCHEMA VERIFICATION — daily at 6am UTC
-- Catches silent schema drift from deploys or migrations.
-- -------------------------------------------------------
SELECT cron.schedule(
  'pmci-verify-schema',
  '0 6 * * *',
  $$
    SELECT net.http_post(
      url := current_setting('app.pmci_internal_trigger_url'),
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key')),
      body := '{"job":"verify:schema"}'::jsonb
    );
  $$
);

-- -------------------------------------------------------
-- 5. DAILY AUDIT UMBRELLA — daily at 7am UTC
-- Runs pmci:audit:live (schema + smoke + proposer checks).
-- Fires after schema verify (6am) so any schema drift is already flagged.
-- -------------------------------------------------------
SELECT cron.schedule(
  'pmci-audit-live',
  '0 7 * * *',
  $$
    SELECT net.http_post(
      url := current_setting('app.pmci_internal_trigger_url'),
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key')),
      body := '{"job":"audit:live"}'::jsonb
    );
  $$
);
