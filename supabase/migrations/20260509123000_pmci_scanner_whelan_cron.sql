-- Stream B — Track A Whelan structural daily aggregate via pmci-job-runner → pmci-api.
-- Schedule: 02:00 UTC daily (previous UTC calendar day window inside SQL).

DO $$
DECLARE
  jid bigint;
BEGIN
  SELECT job.jobid INTO jid FROM cron.job job WHERE job.jobname = 'pmci-scanner-whelan-aggregate' LIMIT 1;
  IF jid IS NOT NULL THEN PERFORM cron.unschedule(jid); END IF;
END $$;

SELECT cron.schedule(
  'pmci-scanner-whelan-aggregate',
  '0 2 * * *',
  $$ SELECT net.http_post(
      url := pmci._job_runner_url(),
      headers := pmci._job_runner_headers(),
      body := '{"job":"pmci-scanner-whelan-aggregate"}'::jsonb
    ); $$
);

-- Pattern 4 checklist (operator / CI):
--   scripts/validation/pmci-scanner-whelan-validation.sql
--   SELECT job_run from cron.job_run_details for jobname = 'pmci-scanner-whelan-aggregate'.
