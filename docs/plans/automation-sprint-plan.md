# PMCI Automation Sprint Plan
# PM2 + pg_cron + Supabase Edge Functions

_Written: 2026-04-14 | Status: Ready for execution after E2 carry-forward cleanup_

---

## Prerequisites

This sprint executes **after** the E2 carry-forward items are resolved:
1. `signals/top-divergences` 503 fix
2. Politics families dedup (6 families)
3. Family 3120 relabel (politics → sports)

Once those are done, execute this plan in order. Do not run sprints in parallel.

---

## Sprint 1 — PM2: Process Runtime (do this first)

PM2 owns the two long-running processes: the observer and the PMCI API. It keeps them alive across crashes and reboots, replacing all manual `npm run start` and `npm run api:pmci` invocations.

### Step 1.1 — Install PM2 globally

```bash
npm install -g pm2
```

Verify: `pm2 --version`

### Step 1.2 — Create ecosystem config

Create `ecosystem.config.cjs` in the root of the `prediction-machine` repo:

```javascript
module.exports = {
  apps: [
    {
      name: 'pmci-observer',
      script: 'observer.mjs',
      interpreter: 'node',
      cwd: '/path/to/prediction-machine',   // ← set to your actual repo path
      env_file: '.env',
      restart_delay: 5000,                  // 5s between restart attempts
      max_restarts: 10,
      min_uptime: '30s',
      log_file: 'logs/pmci-observer.log',
      error_file: 'logs/pmci-observer-error.log',
      time: true,
    },
    {
      name: 'pmci-api',
      script: 'src/api.mjs',
      interpreter: 'node',
      cwd: '/path/to/prediction-machine',   // ← set to your actual repo path
      env_file: '.env',
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '30s',
      log_file: 'logs/pmci-api.log',
      error_file: 'logs/pmci-api-error.log',
      time: true,
    }
  ]
};
```

Create the logs directory:
```bash
mkdir -p logs
```

### Step 1.3 — Start and validate

```bash
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs pmci-observer --lines 20
pm2 logs pmci-api --lines 20
```

Verify both show `online`. Then hit `GET /v1/health/slo` to confirm the API is serving.

### Step 1.4 — Register PM2 for auto-start on reboot

```bash
pm2 startup        # follow the printed command (it's OS-specific, copy and run it)
pm2 save           # saves current process list
```

After this, PM2 will restart both processes on machine reboot with no manual intervention.

### Step 1.5 — Add convenience scripts to package.json

Add to `scripts` in `package.json`:

```json
"pm2:start": "pm2 start ecosystem.config.cjs",
"pm2:stop": "pm2 stop all",
"pm2:restart": "pm2 restart all",
"pm2:status": "pm2 status",
"pm2:logs": "pm2 logs --lines 50"
```

---

## Sprint 2 — pg_cron: Database-Side Jobs

pg_cron is already enabled in your Supabase project (proven by `20260331000002_snapshot_retention.sql`). This sprint adds all remaining DB-side scheduled jobs as a single migration.

### Step 2.1 — Create the migration file

Create `supabase/migrations/20260414000001_pmci_pg_cron_jobs.sql`:

```sql
-- PMCI Automation Sprint — pg_cron scheduled jobs
-- Requires: pg_cron extension (already enabled via 20260331000002)
-- Cadence rationale documented inline for each job

-- -------------------------------------------------------
-- 1. SPORTS INGEST — every 4 hours
-- Replaces the Cowork "pmci-sports-ingest" scheduled task.
-- Keeps provider_markets and snapshots fresh for sports category.
-- -------------------------------------------------------
SELECT cron.schedule(
  'pmci-ingest-sports',
  '0 */4 * * *',
  $$
    SELECT net.http_post(
      url := current_setting('app.pmci_internal_trigger_url'),
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key')),
      body := '{"job":"ingest:sports"}'::jsonb
    );
  $$
);

-- -------------------------------------------------------
-- 2. POLITICS UNIVERSE INGEST — every 4 hours (offset by 2h from sports)
-- Parity with sports ingest. No equivalent was previously scheduled.
-- -------------------------------------------------------
SELECT cron.schedule(
  'pmci-ingest-politics',
  '0 2,6,10,14,18,22 * * *',
  $$
    SELECT net.http_post(
      url := current_setting('app.pmci_internal_trigger_url'),
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key')),
      body := '{"job":"ingest:politics"}'::jsonb
    );
  $$
);

-- -------------------------------------------------------
-- 3. STALE CLEANUP — nightly at 2am UTC
-- Critical missing job flagged in system-state.md.
-- Guard is baked into stale-cleanup.mjs (linked markets check).
-- Run at 2am (before snapshot retention at 3am) so stales are
-- cleared before the retention window computes.
-- -------------------------------------------------------
SELECT cron.schedule(
  'pmci-stale-cleanup',
  '0 2 * * *',
  $$
    SELECT net.http_post(
      url := current_setting('app.pmci_internal_trigger_url'),
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key')),
      body := '{"job":"stale-cleanup"}'::jsonb
    );
  $$
);

-- -------------------------------------------------------
-- 4. SCHEMA VERIFICATION — daily at 6am UTC
-- Catches silent schema drift from deploys or migrations.
-- -------------------------------------------------------
SELECT cron.schedule(
  'pmci-verify-schema',
  '0 6 * * *',
  $$
    SELECT net.http_post(
      url := current_setting('app.pmci_internal_trigger_url'),
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key')),
      body := '{"job":"verify:schema"}'::jsonb
    );
  $$
);

-- -------------------------------------------------------
-- 5. DAILY AUDIT UMBRELLA — daily at 7am UTC
-- Runs pmci:audit:live (schema + smoke + proposer checks).
-- Fires after schema verify (6am) so any schema drift is already flagged.
-- -------------------------------------------------------
SELECT cron.schedule(
  'pmci-audit-live',
  '0 7 * * *',
  $$
    SELECT net.http_post(
      url := current_setting('app.pmci_internal_trigger_url'),
      headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key')),
      body := '{"job":"audit:live"}'::jsonb
    );
  $$
);

-- -------------------------------------------------------
-- VERIFY: list all scheduled jobs after applying
-- Run this query manually in Supabase SQL editor to confirm:
--   SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;
-- -------------------------------------------------------
```

> **Note on net.http_post:** This migration assumes the `pg_net` extension is available in your Supabase project, which is standard on Pro/Team tiers. The jobs POST to an internal Edge Function trigger endpoint (defined in Sprint 3). If pg_net is not available, see the fallback approach in the Appendix.

### Step 2.2 — Push the migration

```bash
npm run db:push
```

Then verify in Supabase SQL editor:
```sql
SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;
```

Expected output: 6 rows (5 new + existing `pmci-snapshot-retention`).

---

## Sprint 3 — Supabase Edge Functions: Job Dispatcher

The pg_cron jobs POST to a single Edge Function that dispatches each job by name. This keeps all job logic in the repo (not embedded in SQL), and gives you logs, error handling, and easy modification.

### Step 3.1 — Create the Edge Functions directory structure

```bash
mkdir -p supabase/functions/pmci-job-runner
```

### Step 3.2 — Create the dispatcher function

Create `supabase/functions/pmci-job-runner/index.ts`:

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// Job dispatcher for PMCI pg_cron scheduled jobs.
// Called by pg_cron via net.http_post, or directly for manual triggers.
// Each job name maps to a shell command that runs on the PMCI server.

const PMCI_API_KEY = Deno.env.get("PMCI_API_KEY") ?? "";
const PMCI_SERVER_URL = Deno.env.get("PMCI_SERVER_URL") ?? ""; // internal API base URL

const JOB_MAP: Record<string, string> = {
  "ingest:sports":     "/v1/admin/jobs/ingest-sports",
  "ingest:politics":   "/v1/admin/jobs/ingest-politics",
  "stale-cleanup":     "/v1/admin/jobs/stale-cleanup",
  "verify:schema":     "/v1/admin/jobs/verify-schema",
  "audit:live":        "/v1/admin/jobs/audit-live",
};

serve(async (req: Request) => {
  // Auth gate
  const key = req.headers.get("x-pmci-api-key");
  if (key !== PMCI_API_KEY) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { job?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const job = body?.job;
  if (!job || !JOB_MAP[job]) {
    return new Response(
      JSON.stringify({ error: "unknown job", job, available: Object.keys(JOB_MAP) }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const targetUrl = `${PMCI_SERVER_URL}${JOB_MAP[job]}`;

  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "x-pmci-api-key": PMCI_API_KEY,
        "Content-Type": "application/json",
      },
    });
    const result = await res.json();
    console.log(`[pmci-job-runner] job=${job} status=${res.status}`, result);
    return new Response(JSON.stringify({ job, status: res.status, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(`[pmci-job-runner] job=${job} error=`, err);
    return new Response(JSON.stringify({ job, error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
```

### Step 3.3 — Add admin job routes to src/api.mjs

The Edge Function calls `/v1/admin/jobs/*` endpoints on the PMCI API. These routes trigger the npm scripts server-side. Add to `src/api.mjs` (or a new `src/routes/admin-jobs.mjs` wired in via `src/server.mjs`):

```javascript
// Admin job trigger routes — called by Supabase Edge Function dispatcher
// Auth: x-pmci-api-key (same gate as /v1/review/*)
// These are fire-and-respond: they spawn the job and return immediately.
// Job output goes to PM2 logs.

import { spawn } from 'child_process';

const ADMIN_JOBS = {
  'ingest-sports':   ['node', ['lib/ingestion/sports-universe.mjs']],
  'ingest-politics': ['node', ['scripts/ingestion/pmci-ingest-politics-universe.mjs']],
  'stale-cleanup':   ['node', ['scripts/stale-cleanup.mjs']],
  'verify-schema':   ['node', ['scripts/validation/verify-pmci-schema.mjs']],
  'audit-live':      ['bash', ['scripts/run_pmci_live_audit.sh']],
};

// Register as: POST /v1/admin/jobs/:jobName
fastify.post('/v1/admin/jobs/:jobName', { preHandler: [pmciAuthGate] }, async (req, reply) => {
  const { jobName } = req.params;
  const job = ADMIN_JOBS[jobName];
  if (!job) {
    return reply.code(404).send({ error: 'unknown job', jobName });
  }
  const [cmd, args] = job;
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  child.unref();
  const pid = child.pid;
  console.log(`[admin-jobs] spawned job=${jobName} pid=${pid}`);
  return reply.code(202).send({ job: jobName, pid, status: 'spawned' });
});
```

> **Important:** `child.unref()` ensures the spawned job doesn't block the API process. Job output is captured in PM2 logs since the API process itself is managed by PM2.

### Step 3.4 — Set Edge Function environment variables

In Supabase Dashboard → Edge Functions → pmci-job-runner → Secrets, add:

| Key | Value |
|---|---|
| `PMCI_API_KEY` | Your API key from `.env` |
| `PMCI_SERVER_URL` | Your PMCI API base URL (e.g., `https://your-pmci-host.com`) |

### Step 3.5 — Deploy the Edge Function

```bash
npx supabase functions deploy pmci-job-runner
```

### Step 3.6 — Set pg_cron app settings

In Supabase SQL editor, set the two app-level settings that pg_cron references:

```sql
ALTER DATABASE postgres SET app.pmci_internal_trigger_url = 'https://<your-project-ref>.supabase.co/functions/v1/pmci-job-runner';
ALTER DATABASE postgres SET app.pmci_api_key = '<your-pmci-api-key>';
```

---

## Sprint 4 — Health Check Monitoring Jobs

These jobs poll the API health endpoints on a frequent cadence and log results. Unlike ingest jobs, these run directly via pg_cron + pg_net (no Edge Function needed — they're just HTTP GETs logging results to a table).

### Step 4.1 — Create health log table

Add to a new migration `supabase/migrations/20260414000002_pmci_health_log.sql`:

```sql
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

-- Auto-purge health log entries older than 7 days (keep it lean)
SELECT cron.schedule(
  'pmci-health-log-purge',
  '0 4 * * *',
  $$
    DELETE FROM pmci.health_log WHERE checked_at < NOW() - INTERVAL '7 days';
  $$
);
```

### Step 4.2 — Add health poll jobs to the pg_cron migration

Append to `supabase/migrations/20260414000001_pmci_pg_cron_jobs.sql` (or add a follow-on migration):

```sql
-- -------------------------------------------------------
-- HEALTH POLLS — via pg_net HTTP GET to API endpoints
-- Results logged to pmci.health_log for trend tracking.
-- -------------------------------------------------------

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
```

Add the server URL app setting:
```sql
ALTER DATABASE postgres SET app.pmci_server_url = 'https://your-pmci-host.com';
```

---

## Full Cadence Summary

| Job | Tool | Schedule | Purpose |
|---|---|---|---|
| `pmci-snapshot-retention` | pg_cron (existing) | `0 3 * * *` | Delete snapshots >30 days |
| `pmci-ingest-sports` | pg_cron → Edge Fn | `0 */4 * * *` | Sports universe refresh |
| `pmci-ingest-politics` | pg_cron → Edge Fn | `0 2,6,10,14,18,22 * * *` | Politics universe refresh |
| `pmci-stale-cleanup` | pg_cron → Edge Fn | `0 2 * * *` | Clear stale-active markets |
| `pmci-verify-schema` | pg_cron → Edge Fn | `0 6 * * *` | Schema integrity check |
| `pmci-audit-live` | pg_cron → Edge Fn | `0 7 * * *` | Daily audit umbrella |
| `pmci-health-freshness` | pg_cron → pg_net | `*/5 * * * *` | Freshness lag poll |
| `pmci-health-slo` | pg_cron → pg_net | `*/5 * * * *` | SLO check poll |
| `pmci-health-observer` | pg_cron → pg_net | `*/5 * * * *` | Observer heartbeat poll |
| `pmci-health-projection-ready` | pg_cron → pg_net | `*/15 * * * *` | Projection readiness poll |
| `pmci-health-log-purge` | pg_cron | `0 4 * * *` | Health log cleanup (7-day TTL) |
| `pmci-observer` (process) | PM2 | on-crash / on-boot | Observer process watchdog |
| `pmci-api` (process) | PM2 | on-crash / on-boot | API process watchdog |

---

## Verification Checklist

Run these after all sprints are complete:

```bash
# PM2
pm2 status                          # both processes show "online"
pm2 logs pmci-observer --lines 20   # no crash loops
pm2 logs pmci-api --lines 20        # API serving requests

# pg_cron jobs registered
# (run in Supabase SQL editor)
# SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;

# Edge Function reachable
curl -X POST https://<project-ref>.supabase.co/functions/v1/pmci-job-runner \
  -H "x-pmci-api-key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{"job":"verify:schema"}'

# Health log populating (run after 5 minutes)
# SELECT endpoint, is_healthy, checked_at FROM pmci.health_log ORDER BY checked_at DESC LIMIT 20;

# Full system check
npm run pmci:smoke
npm run verify:schema
npm run pmci:status
```

---

## Appendix: Fallback if pg_net is Unavailable

If your Supabase tier does not have `pg_net`, the pg_cron jobs cannot make HTTP calls directly. Use this alternative approach for Sprint 2:

1. Remove all `net.http_post` calls from the migration
2. Instead, schedule pg_cron to write a trigger record to a `pmci.job_queue` table
3. Add a polling loop to the Edge Function (invoked on a timer via Supabase's built-in cron scheduler in the Dashboard) that reads and executes pending queue entries
4. This is more complex but removes the pg_net dependency entirely

Alternatively, upgrade to Supabase Pro if you haven't already — pg_net is available on all paid tiers and is the cleanest path.

---

_This plan was written 2026-04-14. Execute after E2 carry-forward cleanup is complete._
