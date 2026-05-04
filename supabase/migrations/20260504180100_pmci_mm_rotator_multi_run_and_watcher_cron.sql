-- Extra rotator invocations (sports-friendly UTC anchors) + 5-minute MM disable watcher.

SELECT cron.schedule(
  'pmci-mm-rotate-tickers-pre-mlb',
  '0 16 * * *',
  $$ SELECT net.http_post(
      url := pmci._job_runner_url(),
      headers := pmci._job_runner_headers(),
      body := '{"job":"mm-rotate-tickers","mm_run_mode":"prod"}'::jsonb
    ); $$
);

SELECT cron.schedule(
  'pmci-mm-rotate-tickers-pre-nba',
  '0 22 * * *',
  $$ SELECT net.http_post(
      url := pmci._job_runner_url(),
      headers := pmci._job_runner_headers(),
      body := '{"job":"mm-rotate-tickers","mm_run_mode":"prod"}'::jsonb
    ); $$
);

SELECT cron.schedule(
  'pmci-mm-rotator-disable-watcher',
  '*/5 * * * *',
  $$ SELECT net.http_post(
      url := pmci._job_runner_url(),
      headers := pmci._job_runner_headers(),
      body := '{"job":"mm-rotator-disable-watcher"}'::jsonb
    ); $$
);
