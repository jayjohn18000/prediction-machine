-- Phase E2 — auto-review cron jobs (crypto + economics).
-- Runs propose + auto-accept + audit for crypto and economics categories
-- a few hours offset from ingest so proposers have fresh provider_markets.
-- Invokes pmci-job-runner Edge Function (see supabase/functions/pmci-job-runner/index.ts).

SELECT cron.schedule(
  'pmci-review-crypto',
  '0 8,14,20,2 * * *',
  $$
    SELECT net.http_post(
      url := current_setting('app.pmci_internal_trigger_url'),
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key')),
      body := '{"job":"review:crypto"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'pmci-review-economics',
  '0 6,12,18,0 * * *',
  $$
    SELECT net.http_post(
      url := current_setting('app.pmci_internal_trigger_url'),
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key')),
      body := '{"job":"review:economics"}'::jsonb
    );
  $$
);
