-- Health check result log for monitoring job output
CREATE TABLE IF NOT EXISTS pmci.health_log (
  id           BIGSERIAL PRIMARY KEY,
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  endpoint     TEXT NOT NULL,
  http_status  INT,
  response_ms  INT,
  is_healthy   BOOLEAN,
  payload      JSONB
);

CREATE INDEX idx_pmci_health_log_checked_at ON pmci.health_log (checked_at DESC);
CREATE INDEX idx_pmci_health_log_endpoint   ON pmci.health_log (endpoint, checked_at DESC);

-- Auto-purge health log entries older than 7 days
SELECT cron.schedule(
  'pmci-health-log-purge',
  '0 4 * * *',
  $$
    DELETE FROM pmci.health_log WHERE checked_at < NOW() - INTERVAL '7 days';
  $$
);
