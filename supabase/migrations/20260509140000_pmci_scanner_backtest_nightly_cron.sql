-- Stream E — nightly snapshot replay → pmci-job-runner → scanner-backtest-nightly (04:30 UTC, after decay window).

SELECT cron.schedule(
  'pmci-scanner-backtest-nightly',
  '30 4 * * *',
  $$ SELECT net.http_post(
      url := pmci._job_runner_url(),
      headers := pmci._job_runner_headers(),
      body := '{"job":"scanner-backtest-nightly"}'::jsonb
    ); $$
);
