-- W5 — mm_market_config.toxicity_threshold + pg_cron → pmci-job-runner → mm-post-fill-backfill admin job.

ALTER TABLE pmci.mm_market_config
  ADD COLUMN IF NOT EXISTS toxicity_threshold int NOT NULL DEFAULT 500;

COMMENT ON COLUMN pmci.mm_market_config.toxicity_threshold IS
  'W5: compare to computeToxicityScore() output; breach trips kill-switch automation.';

-- Requires prior migrations defining pmci._job_runner_url / pmci._job_runner_headers (Vault).
DO $$
DECLARE
  jid bigint;
BEGIN
  SELECT job.jobid INTO jid FROM cron.job job WHERE job.jobname = 'pmci-mm-post-fill-backfill' LIMIT 1;
  IF jid IS NOT NULL THEN PERFORM cron.unschedule(jid); END IF;
END $$;

SELECT cron.schedule(
  'pmci-mm-post-fill-backfill',
  '* * * * *',
  $$ SELECT net.http_post(
      url := pmci._job_runner_url(),
      headers := pmci._job_runner_headers(),
      body := '{"job":"mm-post-fill-backfill"}'::jsonb
    ); $$
);
