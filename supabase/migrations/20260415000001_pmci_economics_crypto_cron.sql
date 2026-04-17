-- Phase E parallel tracks — scheduled economics + crypto ingestion (parity with sports/politics).
-- Invokes pmci-job-runner Edge Function with new job names (see supabase/functions/pmci-job-runner/index.ts).
-- NOTE (2026-04-17): Hardcoded URLs/keys — Supabase managed Postgres blocks current_setting() writes.

SELECT cron.schedule(
  'pmci-ingest-economics',
  '30 3,7,11,15,19,23 * * *',
  $$
    SELECT net.http_post(
      url := 'https://awueugxrdlolzjzikero.supabase.co/functions/v1/pmci-job-runner',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF3dWV1Z3hyZGxvbHpqemlrZXJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3OTAzNTEsImV4cCI6MjA4NzM2NjM1MX0.iFCMVUqrZf0Hfy3hG9tyarltFfl5pKsM2eNdblq5NYE","x-pmci-api-key":"VcrD2S8kTWLJpik4"}'::jsonb,
      body := '{"job":"ingest:economics"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'pmci-ingest-crypto',
  '30 5,9,13,17,21,1 * * *',
  $$
    SELECT net.http_post(
      url := 'https://awueugxrdlolzjzikero.supabase.co/functions/v1/pmci-job-runner',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF3dWV1Z3hyZGxvbHpqemlrZXJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3OTAzNTEsImV4cCI6MjA4NzM2NjM1MX0.iFCMVUqrZf0Hfy3hG9tyarltFfl5pKsM2eNdblq5NYE","x-pmci-api-key":"VcrD2S8kTWLJpik4"}'::jsonb,
      body := '{"job":"ingest:crypto"}'::jsonb
    );
  $$
);
