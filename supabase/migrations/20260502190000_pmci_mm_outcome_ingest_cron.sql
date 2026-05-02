-- ADR-011 cutover gate 4: settlement→balance trail.
--
-- Wire runMarketOutcomeIngest into pg_cron via the pmci-job-runner Edge Function.
-- Hourly cadence (cheap; no live writes when nothing has settled).
--
-- Pattern-4 validation (rows-actually-landing) is encoded as a comment block
-- below the schedule call. CI / operator runs the SELECT to confirm rows are
-- landing inside the expected interval.

DO $$
DECLARE
  v_existing_jobid BIGINT;
BEGIN
  SELECT jobid INTO v_existing_jobid
  FROM cron.job
  WHERE jobname = 'mm-ingest-outcomes';

  IF v_existing_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_existing_jobid);
  END IF;
END$$;

SELECT cron.schedule(
  'mm-ingest-outcomes',
  '7 * * * *',  -- every hour at :07 (offset from other top-of-hour crons)
  $$ SELECT pmci.trigger_job_runner('mm-ingest-outcomes') $$
);

-- Pattern-4 validation. Run this in psql or via Supabase MCP after the migration
-- and ≥1 hour later to confirm the writer actually persisted rows.
--
-- Step A — confirm cron ran in the expected interval:
--   SELECT job.jobname, run.start_time, run.status, run.return_message
--   FROM cron.job_run_details run
--   JOIN cron.job job USING (jobid)
--   WHERE job.jobname = 'mm-ingest-outcomes'
--     AND run.start_time > now() - interval '90 minutes'
--   ORDER BY run.start_time DESC LIMIT 5;
--
-- Step B — confirm DB rows actually landed (the silent-success guard):
--   SELECT
--     date_trunc('hour', last_seen_at) AS hr,
--     count(*) AS outcomes_in_hour
--   FROM pmci.market_outcomes
--   WHERE last_seen_at > now() - interval '24 hours'
--   GROUP BY 1 ORDER BY 1 DESC LIMIT 24;
--
-- Step C — find any markets that closed but lack an outcome (gate 4 monitor):
--   SELECT pm.id, pm.provider_market_ref, pm.status, pm.close_time
--   FROM pmci.provider_markets pm
--   LEFT JOIN pmci.market_outcomes mo
--     ON mo.provider_market_id = pm.id
--   WHERE pm.close_time < now() - interval '1 hour'
--     AND pm.status IN ('closed', 'settled', 'finalized')
--     AND mo.id IS NULL
--     AND pm.id IN (SELECT market_id FROM pmci.mm_market_config WHERE enabled = true)
--   LIMIT 20;
