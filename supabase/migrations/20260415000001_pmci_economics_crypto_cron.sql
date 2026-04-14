-- Phase E parallel tracks — scheduled economics + crypto ingestion (parity with sports/politics).
-- Invokes pmci-job-runner Edge Function with new job names (see supabase/functions/pmci-job-runner/index.ts).

SELECT cron.schedule(
  'pmci-ingest-economics',
  '30 3,7,11,15,19,23 * * *',
  $$
    SELECT net.http_post(
      url := current_setting('app.pmci_internal_trigger_url'),
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key')),
      body := '{"job":"ingest:economics"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'pmci-ingest-crypto',
  '30 5,9,13,17,21,1 * * *',
  $$
    SELECT net.http_post(
      url := current_setting('app.pmci_internal_trigger_url'),
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key')),
      body := '{"job":"ingest:crypto"}'::jsonb
    );
  $$
);
