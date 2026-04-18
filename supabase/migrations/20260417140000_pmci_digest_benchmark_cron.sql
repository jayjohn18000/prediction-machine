-- Daily PMCI status digest (logs via Edge → Fly admin job) + weekly coverage benchmark.
-- Headers match other pmci-job-runner cron migrations; rotate keys in Supabase Dashboard if needed.

SELECT cron.schedule(
  'pmci-status-digest',
  '30 8 * * *',
  $$
    SELECT net.http_post(
      url := 'https://awueugxrdlolzjzikero.supabase.co/functions/v1/pmci-job-runner',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF3dWV1Z3hyZGxvbHpqemlrZXJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3OTAzNTEsImV4cCI6MjA4NzM2NjM1MX0.iFCMVUqrZf0Hfy3hG9tyarltFfl5pKsM2eNdblq5NYE","x-pmci-api-key":"VcrD2S8kTWLJpik4"}'::jsonb,
      body := '{"job":"status:digest"}'::jsonb
    );
  $$
);

SELECT cron.schedule(
  'pmci-benchmark-coverage',
  '0 11 * * 0',
  $$
    SELECT net.http_post(
      url := 'https://awueugxrdlolzjzikero.supabase.co/functions/v1/pmci-job-runner',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF3dWV1Z3hyZGxvbHpqemlrZXJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3OTAzNTEsImV4cCI6MjA4NzM2NjM1MX0.iFCMVUqrZf0Hfy3hG9tyarltFfl5pKsM2eNdblq5NYE","x-pmci-api-key":"VcrD2S8kTWLJpik4"}'::jsonb,
      body := '{"job":"benchmark:coverage"}'::jsonb
    );
  $$
);
