-- Stream F — hypothesis_state_log, alert delivery helpers, scanner output pg_cron via pmci.trigger_job_runner.
-- Requires: Vault secret pmci_job_runner_headers + pmci._job_runner_url() helpers (migration 20260419100000).
-- Stream A artefacts (pmci.hypotheses, scanner views, pmci.alerts) must exist before this applies.

CREATE OR REPLACE FUNCTION pmci.trigger_job_runner(p_job text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM net.http_post(
    url := pmci._job_runner_url(),
    headers := pmci._job_runner_headers(),
    body := jsonb_build_object('job', p_job)
  );
END;
$$;

COMMENT ON FUNCTION pmci.trigger_job_runner(text) IS
  'Edge pmci-job-runner dispatcher: forwards job name JSON body for pg_cron.';

CREATE TABLE IF NOT EXISTS pmci.hypothesis_state_log (
  id              BIGSERIAL PRIMARY KEY,
  hypothesis_id   TEXT NOT NULL,
  from_status     TEXT NOT NULL,
  to_status       TEXT NOT NULL,
  transition_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason          TEXT,
  actor           TEXT NOT NULL DEFAULT 'system'
);

COMMENT ON COLUMN pmci.hypothesis_state_log.hypothesis_id IS
  'Matches pmci.hypotheses logical id — keep text to avoid FK type clashes across Stream A drafts.';

CREATE INDEX IF NOT EXISTS hypothesis_state_log_hypothesis_idx ON pmci.hypothesis_state_log(hypothesis_id, transition_at DESC);

REVOKE ALL ON TABLE pmci.hypothesis_state_log FROM PUBLIC;
REVOKE ALL ON TABLE pmci.hypothesis_state_log FROM anon;
REVOKE ALL ON TABLE pmci.hypothesis_state_log FROM authenticated;
GRANT SELECT, INSERT ON TABLE pmci.hypothesis_state_log TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE pmci.hypothesis_state_log_id_seq TO service_role, postgres;

DO $$
BEGIN
  IF to_regclass('pmci.hypotheses') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE pmci.hypotheses ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ';
    EXECUTE 'ALTER TABLE pmci.hypotheses ADD COLUMN IF NOT EXISTS retired_reason TEXT';
  END IF;

  IF to_regclass('pmci.alerts') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE pmci.alerts ADD COLUMN IF NOT EXISTS delivery_attempts INT NOT NULL DEFAULT 0';
    EXECUTE 'ALTER TABLE pmci.alerts ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ';
    EXECUTE 'ALTER TABLE pmci.alerts ADD COLUMN IF NOT EXISTS tradable BOOLEAN NOT NULL DEFAULT true';
    EXECUTE 'ALTER TABLE pmci.alerts ADD COLUMN IF NOT EXISTS body TEXT';
    EXECUTE 'ALTER TABLE pmci.alerts ADD COLUMN IF NOT EXISTS subject TEXT';
  END IF;
END $$;

DO $$
DECLARE v BIGINT;
BEGIN
  SELECT jobid INTO v FROM cron.job WHERE jobname = 'pmci-scanner-daily-report';
  IF v IS NOT NULL THEN PERFORM cron.unschedule(v); END IF;
  SELECT jobid INTO v FROM cron.job WHERE jobname = 'pmci-scanner-alert-delivery';
  IF v IS NOT NULL THEN PERFORM cron.unschedule(v); END IF;
  SELECT jobid INTO v FROM cron.job WHERE jobname = 'pmci-scanner-weekly-digest';
  IF v IS NOT NULL THEN PERFORM cron.unschedule(v); END IF;
END $$;

SELECT cron.schedule(
  'pmci-scanner-daily-report',
  '30 0 * * *',
  $$ SELECT pmci.trigger_job_runner('scanner:daily-report') $$
);

SELECT cron.schedule(
  'pmci-scanner-alert-delivery',
  '* * * * *',
  $$ SELECT pmci.trigger_job_runner('scanner:alert-delivery') $$
);

SELECT cron.schedule(
  'pmci-scanner-weekly-digest',
  '0 6 * * 0',
  $$ SELECT pmci.trigger_job_runner('scanner:weekly-digest') $$
);

-- Pattern 4 — pmci-scanner-daily-report
-- cron.job_run_details: SELECT job.jobname, run.start_time, run.status, run.return_message
--   FROM cron.job_run_details run JOIN cron.job job USING (jobid)
--   WHERE job.jobname='pmci-scanner-daily-report' AND run.start_time > now() - interval '2 hours';
-- Artefact landing: filesystem /reports/daily/daily-report-YYYY-MM-DD.html on Fly (or S3 mirror).

-- Pattern 4 — pmci-scanner-alert-delivery (rows update in pmci.alerts)
--   SELECT hypothesis_id, id, fired_at, delivered_at, delivery_status
--     FROM pmci.alerts ORDER BY fired_at DESC NULLS LAST LIMIT 20;

-- Pattern 4 — pmci-scanner-weekly-digest
-- Artefact landing: filesystem /reports/weekly/weekly-digest-YYYY-Www.html (+ auto-retire rows in hypotheses / hypothesis_state_log).
