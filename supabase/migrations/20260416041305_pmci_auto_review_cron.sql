-- Phase E2 — auto-review cron jobs (crypto + economics).
-- Runs propose + auto-accept + audit for crypto and economics categories
-- a few hours offset from ingest so proposers have fresh provider_markets.
-- Invokes pmci-job-runner Edge Function (see supabase/functions/pmci-job-runner/index.ts).
-- NOTE (2026-04-17): Hardcoded URLs/keys — Supabase managed Postgres blocks current_setting() writes.

SELECT cron.schedule(
  'pmci-review-crypto',
  '0 8,14,20,2 * * *',
  $$
    SELECT net.http_post(
      url := 'https://awueugxrdlolzjzikero.supabase.co/functions/v1/pmci-job-runner',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF3dWV1Z3hyZGxvbHpqemlrZXJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3OTAzNTEsImV4cCI6MjA4NzM2NjM1MX0.iFCMVUqrZf0Hfy3hG9tyarltFfl5pKsM2eNdblq5NYE","x-pmci-api-key":"VcrD2S8kTWLJpik4"}'::jsonb,
      body := '{"job":"review:crypto"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'pmci-review-economics',
  '0 6,12,18,0 * * *',
  $$
    SELECT net.http_post(
      url := 'https://awueugxrdlolzjzikero.supabase.co/functions/v1/pmci-job-runner',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF3dWV1Z3hyZGxvbHpqemlrZXJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3OTAzNTEsImV4cCI6MjA4NzM2NjM1MX0.iFCMVUqrZf0Hfy3hG9tyarltFfl5pKsM2eNdblq5NYE","x-pmci-api-key":"VcrD2S8kTWLJpik4"}'::jsonb,
      body := '{"job":"review:economics"}'::jsonb
    );
  $$
);
