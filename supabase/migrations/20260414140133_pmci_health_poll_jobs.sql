-- PMCI health poll jobs — pg_cron + pg_net HTTP GET to API endpoints.
-- Results logged to pmci.health_log for trend tracking.
-- Requires: pmci.health_log table (20260414000002), pg_net extension.

-- Freshness check — every 5 minutes
SELECT cron.schedule(
  'pmci-health-freshness',
  '*/5 * * * *',
  $$
    INSERT INTO pmci.health_log (endpoint, http_status, is_healthy, payload)
    SELECT
      '/v1/health/freshness',
      (response).status_code,
      (response).status_code = 200,
      (response).body::jsonb
    FROM net.http_get(
      url := current_setting('app.pmci_server_url') || '/v1/health/freshness',
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key'))
    ) AS response;
  $$
);

-- SLO check — every 5 minutes
SELECT cron.schedule(
  'pmci-health-slo',
  '*/5 * * * *',
  $$
    INSERT INTO pmci.health_log (endpoint, http_status, is_healthy, payload)
    SELECT
      '/v1/health/slo',
      (response).status_code,
      (response).status_code = 200,
      (response).body::jsonb
    FROM net.http_get(
      url := current_setting('app.pmci_server_url') || '/v1/health/slo',
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key'))
    ) AS response;
  $$
);

-- Observer health — every 5 minutes
SELECT cron.schedule(
  'pmci-health-observer',
  '*/5 * * * *',
  $$
    INSERT INTO pmci.health_log (endpoint, http_status, is_healthy, payload)
    SELECT
      '/v1/health/observer',
      (response).status_code,
      (response).status_code = 200,
      (response).body::jsonb
    FROM net.http_get(
      url := current_setting('app.pmci_server_url') || '/v1/health/observer',
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key'))
    ) AS response;
  $$
);

-- Projection readiness — every 15 minutes
SELECT cron.schedule(
  'pmci-health-projection-ready',
  '*/15 * * * *',
  $$
    INSERT INTO pmci.health_log (endpoint, http_status, is_healthy, payload)
    SELECT
      '/v1/health/projection-ready',
      (response).status_code,
      (response).status_code = 200,
      (response).body::jsonb
    FROM net.http_get(
      url := current_setting('app.pmci_server_url') || '/v1/health/projection-ready',
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key'))
    ) AS response;
  $$
);
