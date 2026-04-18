-- pg_net: http_collect_response errors when called from PL/pgSQL (internal SELECT w/o INTO).
-- Run collection as plain SQL in the cron body; force INSERT CTE to execute via CROSS JOIN.

SELECT cron.unschedule(j.jobid)
FROM cron.job j
WHERE j.jobname = 'pmci-health-collect';

DROP FUNCTION IF EXISTS pmci.collect_health_poll_queue();

SELECT cron.schedule(
  'pmci-health-collect',
  '* * * * *',
  $$
    WITH resp AS (
      SELECT
        q.id AS qid,
        q.endpoint,
        x.status AS st,
        (x.response).status_code AS sc,
        (x.response).body AS raw_body
      FROM pmci.health_poll_queue q
      CROSS JOIN LATERAL net.http_collect_response(q.request_id, false) AS x
      WHERE q.processed_at IS NULL
        AND q.created_at < NOW() - INTERVAL '3 seconds'
    ),
    ins AS (
      INSERT INTO pmci.health_log (endpoint, http_status, is_healthy, payload)
      SELECT
        endpoint,
        sc,
        sc = 200,
        CASE
          WHEN raw_body IS NULL OR btrim(raw_body) = '' THEN '{}'::jsonb
          ELSE raw_body::jsonb
        END
      FROM resp
      WHERE st = 'SUCCESS'
        AND sc IS NOT NULL
      RETURNING 1 AS _
    )
    UPDATE pmci.health_poll_queue p
    SET processed_at = NOW()
    FROM resp r
    CROSS JOIN (SELECT count(*)::int AS ins_rows FROM ins) _ins
    WHERE p.id = r.qid;
  $$
);
