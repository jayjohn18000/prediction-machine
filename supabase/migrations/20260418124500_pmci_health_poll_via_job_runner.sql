-- Health polling: pg_net http_collect_response fails under pg_cron ("query has no destination for result data").
-- Route polls through pmci-job-runner → Fly POST /v1/admin/jobs/health-poll → scripts/ops/pmci-health-poll.mjs (fetch + INSERT).

DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN
    SELECT jobid FROM cron.job
    WHERE jobname IN (
      'pmci-health-enqueue',
      'pmci-health-enqueue-projection',
      'pmci-health-collect'
    )
  LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS pmci.collect_health_poll_queue();
DROP TABLE IF EXISTS pmci.health_poll_queue;

-- Same pattern as pmci-stale-cleanup / ingest jobs (Edge → Fly admin job).
SELECT cron.schedule(
  'pmci-health-poll',
  '*/5 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://awueugxrdlolzjzikero.supabase.co/functions/v1/pmci-job-runner',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF3dWV1Z3hyZGxvbHpqemlrZXJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3OTAzNTEsImV4cCI6MjA4NzM2NjM1MX0.iFCMVUqrZf0Hfy3hG9tyarltFfl5pKsM2eNdblq5NYE","x-pmci-api-key":"VcrD2S8kTWLJpik4"}'::jsonb,
      body := '{"job":"health:poll"}'::jsonb
    );
  $$
);
