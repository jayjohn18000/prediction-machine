-- Fix PMCI health poll crons: pg_net net.http_get returns bigint request_id, not a composite.
-- Enqueue ids in one job; collect in another job via net.http_collect_response (separate txn).
-- URLs/keys align with other PMCI Fly cron migrations.

CREATE TABLE IF NOT EXISTS pmci.health_poll_queue (
  id           BIGSERIAL PRIMARY KEY,
  request_id   BIGINT NOT NULL,
  endpoint     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_health_poll_queue_pending
  ON pmci.health_poll_queue (created_at)
  WHERE processed_at IS NULL;

-- Drop broken jobs (pg_net API mismatch).
DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN
    SELECT jobid FROM cron.job
    WHERE jobname IN (
      'pmci-health-freshness',
      'pmci-health-slo',
      'pmci-health-observer',
      'pmci-health-projection-ready'
    )
  LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION pmci.collect_health_poll_queue()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r RECORD;
  c RECORD;
  payload jsonb;
BEGIN
  FOR r IN
    SELECT q.id, q.request_id, q.endpoint
    FROM pmci.health_poll_queue q
    WHERE q.processed_at IS NULL
      AND q.created_at < NOW() - INTERVAL '3 seconds'
    ORDER BY q.id
    FOR UPDATE SKIP LOCKED
  LOOP
    SELECT * INTO c FROM net.http_collect_response(r.request_id, async := false);
    IF c.status = 'SUCCESS' AND (c.response).status_code IS NOT NULL THEN
      BEGIN
        payload := COALESCE(NULLIF(trim((c.response).body), ''), '{}')::jsonb;
      EXCEPTION WHEN OTHERS THEN
        payload := jsonb_build_object('parse_error', true, 'body', left((c.response).body, 2000));
      END;
      INSERT INTO pmci.health_log (endpoint, http_status, is_healthy, payload)
      VALUES (
        r.endpoint,
        (c.response).status_code,
        (c.response).status_code = 200,
        payload
      );
    END IF;
    UPDATE pmci.health_poll_queue SET processed_at = NOW() WHERE id = r.id;
  END LOOP;
END;
$$;

-- Three endpoints every 5 minutes.
SELECT cron.schedule(
  'pmci-health-enqueue',
  '*/5 * * * *',
  $$
    INSERT INTO pmci.health_poll_queue (request_id, endpoint)
    SELECT net.http_get(
      url := 'https://pmci-api.fly.dev/v1/health/freshness',
      headers := '{"x-pmci-api-key":"VcrD2S8kTWLJpik4"}'::jsonb
    ), '/v1/health/freshness'
    UNION ALL
    SELECT net.http_get(
      url := 'https://pmci-api.fly.dev/v1/health/slo',
      headers := '{"x-pmci-api-key":"VcrD2S8kTWLJpik4"}'::jsonb
    ), '/v1/health/slo'
    UNION ALL
    SELECT net.http_get(
      url := 'https://pmci-api.fly.dev/v1/health/observer',
      headers := '{"x-pmci-api-key":"VcrD2S8kTWLJpik4"}'::jsonb
    ), '/v1/health/observer';
  $$
);

-- Projection-ready every 15 minutes.
SELECT cron.schedule(
  'pmci-health-enqueue-projection',
  '*/15 * * * *',
  $$
    INSERT INTO pmci.health_poll_queue (request_id, endpoint)
    SELECT net.http_get(
      url := 'https://pmci-api.fly.dev/v1/health/projection-ready',
      headers := '{"x-pmci-api-key":"VcrD2S8kTWLJpik4"}'::jsonb
    ), '/v1/health/projection-ready';
  $$
);

SELECT cron.schedule(
  'pmci-health-collect',
  '* * * * *',
  $$ SELECT pmci.collect_health_poll_queue(); $$
);

COMMENT ON TABLE pmci.health_poll_queue IS
  'pg_net request ids; collect_health_poll_queue() runs http_collect_response.';
