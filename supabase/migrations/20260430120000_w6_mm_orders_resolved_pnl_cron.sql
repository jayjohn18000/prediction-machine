-- W6 — mm_orders.status 'resolved' after market settlement; pg_cron → mm-pnl-snapshot job.

ALTER TABLE pmci.mm_orders DROP CONSTRAINT IF EXISTS mm_orders_status_check;

ALTER TABLE pmci.mm_orders
  ADD CONSTRAINT mm_orders_status_check
  CHECK (
    status IN ('pending', 'open', 'filled', 'partial', 'cancelled', 'rejected', 'resolved')
  );

COMMENT ON COLUMN pmci.mm_orders.status IS
  'Lifecycle; resolved = market settled (W6 resolution driver).';

DO $$
DECLARE
  jid bigint;
BEGIN
  SELECT job.jobid INTO jid FROM cron.job job WHERE job.jobname = 'pmci-mm-pnl-snapshot' LIMIT 1;
  IF jid IS NOT NULL THEN PERFORM cron.unschedule(jid); END IF;
END $$;

SELECT cron.schedule(
  'pmci-mm-pnl-snapshot',
  '*/5 * * * *',
  $$ SELECT net.http_post(
      url := pmci._job_runner_url(),
      headers := pmci._job_runner_headers(),
      body := '{"job":"mm-pnl-snapshot"}'::jsonb
    ); $$
);
