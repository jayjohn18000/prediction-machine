-- Fix pmci.collect_health_poll_queue: use composite assignment for net.http_collect_response.
-- SELECT * INTO ... FROM net.http_collect_response(...) can error inside pg_net (PL/pgSQL).

CREATE OR REPLACE FUNCTION pmci.collect_health_poll_queue()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r RECORD;
  c net.http_response_result;
  payload jsonb;
BEGIN
  FOR r IN
    SELECT q.id, q.request_id, q.endpoint
    FROM pmci.health_poll_queue q
    WHERE q.processed_at IS NULL
      AND q.created_at < NOW() - INTERVAL '3 seconds'
    ORDER BY q.id
  LOOP
    BEGIN
      c := net.http_collect_response(r.request_id, false);
    EXCEPTION WHEN OTHERS THEN
      UPDATE pmci.health_poll_queue SET processed_at = NOW() WHERE id = r.id;
      CONTINUE;
    END;

    IF c.status = 'SUCCESS'
       AND c.response IS NOT NULL
       AND (c.response).status_code IS NOT NULL
    THEN
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
