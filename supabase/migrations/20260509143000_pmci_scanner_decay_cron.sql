-- Stream C Phase 0 — nightly hypothesis decay monitor (PSI/KS + KSWIN + feature importance).
-- Dispatched via pmci-job-runner Edge Function → POST /v1/admin/jobs/scanner-decay-nightly.
-- Schedule: 03:30 UTC daily (after Stream B structural cron at 02:00 UTC).

DO $$
DECLARE
  v_existing_jobid BIGINT;
BEGIN
  SELECT jobid INTO v_existing_jobid
  FROM cron.job
  WHERE jobname = 'pmci-scanner-decay-nightly';

  IF v_existing_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_existing_jobid);
  END IF;
END$$;

SELECT cron.schedule(
  'pmci-scanner-decay-nightly',
  '30 3 * * *',
  $$ SELECT net.http_post(
      url := pmci._job_runner_url(),
      headers := pmci._job_runner_headers(),
      body := '{"job":"pmci-scanner-decay-nightly"}'::jsonb
    ); $$
);

-- Pattern-4 validation (rows actually landing):
--
--   SELECT count(*) AS decay_rows_24h
--   FROM pmci.hypothesis_decay_state
--   WHERE computed_at > now() - interval '24 hours';
--
-- After a manual Edge Function trigger (_within ~5 minutes_):
--
--   SELECT count(*), bool_or(triggers_retire)
--   FROM pmci.hypothesis_decay_state
--   WHERE computed_at > now() - interval '5 minutes';
