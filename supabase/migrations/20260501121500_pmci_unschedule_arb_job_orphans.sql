-- Track B.B.2 — Remove pg_cron jobs that dispatched auto-accept / auto-accept:audit / auto-link (if any).
-- Deploy ordering: deploy pmci-api with JOB_MAP + ADMIN_JOBS orphans removed FIRST, then apply this migration.
-- Inventory 2026-05-01: no pmci-auto-accept* or pmci-auto-link jobnames in cron.job; review:* pipelines remain.
DO $$
DECLARE
  j RECORD;
BEGIN
  FOR j IN
    SELECT jobid
    FROM cron.job
    WHERE jobname IN (
      'pmci-auto-accept',
      'pmci-auto-accept-audit',
      'pmci-auto-link'
    )
  LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;
