-- Persist app settings for pg_cron jobs to read via current_setting().
-- These are session-level defaults applied at the database level.
-- NOTE: Supabase managed Postgres may restrict set_config; pmci.app_config is the durable store.
-- URLs/keys match supabase/functions and Edge cron wiring (see pmci_economics_crypto_cron migration).

DO $$
BEGIN
  PERFORM set_config(
    'app.pmci_internal_trigger_url',
    'https://awueugxrdlolzjzikero.supabase.co/functions/v1/pmci-job-runner',
    false
  );
  PERFORM set_config('app.pmci_api_key', 'VcrD2S8kTWLJpik4', false);
  PERFORM set_config(
    'app.pmci_server_url',
    'https://awueugxrdlolzjzikero.supabase.co',
    false
  );
END $$;

CREATE TABLE IF NOT EXISTS pmci.app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO pmci.app_config (key, value) VALUES
  (
    'pmci_internal_trigger_url',
    'https://awueugxrdlolzjzikero.supabase.co/functions/v1/pmci-job-runner'
  ),
  ('pmci_api_key', 'VcrD2S8kTWLJpik4'),
  ('pmci_server_url', 'https://awueugxrdlolzjzikero.supabase.co')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
