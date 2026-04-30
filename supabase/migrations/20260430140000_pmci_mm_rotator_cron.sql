-- MM 7-day-test daily ticker rotator + heartbeat (post-pivot W6 follow-up).
--
-- 09:00 UTC: rotate to today's top-8 demo-tradeable tickers, restart pmci-mm-runtime.
-- 10:00 UTC: heartbeat — confirm ≥6 enabled markets are quoting + writing depth + writing PnL snapshots.
--            Returns 503 if below threshold so pg_cron / health log goes red.
--
-- Requires existing pmci._job_runner_url() / pmci._job_runner_headers() helpers.

DO $$
DECLARE
  jid bigint;
BEGIN
  SELECT job.jobid INTO jid FROM cron.job job WHERE job.jobname = 'pmci-mm-rotate-tickers' LIMIT 1;
  IF jid IS NOT NULL THEN PERFORM cron.unschedule(jid); END IF;
END $$;

SELECT cron.schedule(
  'pmci-mm-rotate-tickers',
  '0 9 * * *',
  $$ SELECT net.http_post(
      url := pmci._job_runner_url(),
      headers := pmci._job_runner_headers(),
      body := '{"job":"mm-rotate-tickers"}'::jsonb
    ); $$
);

DO $$
DECLARE
  jid bigint;
BEGIN
  SELECT job.jobid INTO jid FROM cron.job job WHERE job.jobname = 'pmci-mm-stream-heartbeat' LIMIT 1;
  IF jid IS NOT NULL THEN PERFORM cron.unschedule(jid); END IF;
END $$;

SELECT cron.schedule(
  'pmci-mm-stream-heartbeat',
  '0 10 * * *',
  $$ SELECT net.http_post(
      url := pmci._job_runner_url(),
      headers := pmci._job_runner_headers(),
      body := '{"job":"mm-stream-heartbeat"}'::jsonb
    ); $$
);
