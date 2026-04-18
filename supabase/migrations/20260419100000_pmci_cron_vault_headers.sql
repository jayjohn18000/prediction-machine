-- PMCI pg_cron: unschedule all pmci-* jobs and re-register HTTP jobs using Vault-backed
-- headers (no JWT or x-pmci-api key literals in SQL).
--
-- Prerequisite — create the secret once in the SQL Editor (use rotated credentials):
--   SELECT vault.create_secret(
--     '{"Content-Type":"application/json","Authorization":"Bearer <SUPABASE_ANON_JWT>","x-pmci-api-key":"<PMCI_API_KEY>"}'::text,
--     'pmci_job_runner_headers',
--     'PMCI pg_cron → pmci-job-runner (Authorization + x-pmci-api-key)'
--   );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM vault.decrypted_secrets
    WHERE name = 'pmci_job_runner_headers'
  ) THEN
    RAISE EXCEPTION
      'Missing vault secret pmci_job_runner_headers. Run vault.create_secret(...) with rotated JWT and PMCI_API_KEY — see comment at top of this migration.';
  END IF;
END $$;

-- Unschedule every PMCI-owned cron job (idempotent for partially-applied states).
DO $$
DECLARE
  j RECORD;
BEGIN
  FOR j IN
    SELECT jobid FROM cron.job WHERE jobname LIKE 'pmci-%'
  LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

-- Edge Function URL (project ref is public; secrets live in Vault only).
-- https://<project-ref>.supabase.co/functions/v1/pmci-job-runner
CREATE OR REPLACE FUNCTION pmci._job_runner_url()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'https://awueugxrdlolzjzikero.supabase.co/functions/v1/pmci-job-runner'::text;
$$;

CREATE OR REPLACE FUNCTION pmci._job_runner_headers()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT (s.decrypted_secret)::text::jsonb
  FROM vault.decrypted_secrets s
  WHERE s.name = 'pmci_job_runner_headers'
  LIMIT 1;
$$;

-- Ingest + maintenance (pmci-job-runner)
SELECT cron.schedule(
  'pmci-ingest-sports',
  '0 */4 * * *',
  $$ SELECT net.http_post(url := pmci._job_runner_url(), headers := pmci._job_runner_headers(), body := '{"job":"ingest:sports"}'::jsonb); $$
);

SELECT cron.schedule(
  'pmci-ingest-politics',
  '0 2,6,10,14,18,22 * * *',
  $$ SELECT net.http_post(url := pmci._job_runner_url(), headers := pmci._job_runner_headers(), body := '{"job":"ingest:politics"}'::jsonb); $$
);

SELECT cron.schedule(
  'pmci-stale-cleanup',
  '0 2 * * *',
  $$ SELECT net.http_post(url := pmci._job_runner_url(), headers := pmci._job_runner_headers(), body := '{"job":"stale-cleanup"}'::jsonb); $$
);

SELECT cron.schedule(
  'pmci-verify-schema',
  '0 6 * * *',
  $$ SELECT net.http_post(url := pmci._job_runner_url(), headers := pmci._job_runner_headers(), body := '{"job":"verify:schema"}'::jsonb); $$
);

SELECT cron.schedule(
  'pmci-audit-live',
  '0 7 * * *',
  $$ SELECT net.http_post(url := pmci._job_runner_url(), headers := pmci._job_runner_headers(), body := '{"job":"audit:live"}'::jsonb); $$
);

SELECT cron.schedule(
  'pmci-ingest-economics',
  '30 3,7,11,15,19,23 * * *',
  $$ SELECT net.http_post(url := pmci._job_runner_url(), headers := pmci._job_runner_headers(), body := '{"job":"ingest:economics"}'::jsonb); $$
);

SELECT cron.schedule(
  'pmci-ingest-crypto',
  '30 5,9,13,17,21,1 * * *',
  $$ SELECT net.http_post(url := pmci._job_runner_url(), headers := pmci._job_runner_headers(), body := '{"job":"ingest:crypto"}'::jsonb); $$
);

SELECT cron.schedule(
  'pmci-review-crypto',
  '0 8,14,20,2 * * *',
  $$ SELECT net.http_post(url := pmci._job_runner_url(), headers := pmci._job_runner_headers(), body := '{"job":"review:crypto"}'::jsonb); $$
);

SELECT cron.schedule(
  'pmci-review-economics',
  '0 6,12,18,0 * * *',
  $$ SELECT net.http_post(url := pmci._job_runner_url(), headers := pmci._job_runner_headers(), body := '{"job":"review:economics"}'::jsonb); $$
);

SELECT cron.schedule(
  'pmci-status-digest',
  '30 8 * * *',
  $$ SELECT net.http_post(url := pmci._job_runner_url(), headers := pmci._job_runner_headers(), body := '{"job":"status:digest"}'::jsonb); $$
);

SELECT cron.schedule(
  'pmci-benchmark-coverage',
  '0 11 * * 0',
  $$ SELECT net.http_post(url := pmci._job_runner_url(), headers := pmci._job_runner_headers(), body := '{"job":"benchmark:coverage"}'::jsonb); $$
);

SELECT cron.schedule(
  'pmci-health-poll',
  '*/5 * * * *',
  $$ SELECT net.http_post(url := pmci._job_runner_url(), headers := pmci._job_runner_headers(), body := '{"job":"health:poll"}'::jsonb); $$
);

-- SQL-only jobs (no HTTP secrets)
SELECT cron.schedule(
  'pmci-snapshot-retention',
  '0 3 * * *',
  $$
    DELETE FROM pmci.provider_market_snapshots
    WHERE observed_at < NOW() - INTERVAL '30 days';
  $$
);

SELECT cron.schedule(
  'pmci-health-log-purge',
  '0 4 * * *',
  $$
    DELETE FROM pmci.health_log WHERE checked_at < NOW() - INTERVAL '7 days';
  $$
);

COMMENT ON FUNCTION pmci._job_runner_headers() IS
  'Reads pmci_job_runner_headers from Vault — rotate via vault.update_secret / Dashboard; no keys in migration SQL.';
