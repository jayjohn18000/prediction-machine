import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const PMCI_API_KEY = Deno.env.get("PMCI_API_KEY") ?? "";
const PMCI_ADMIN_KEY = Deno.env.get("PMCI_ADMIN_KEY") ?? "";
const PMCI_SERVER_URL = Deno.env.get("PMCI_SERVER_URL") ?? "";

const JOB_MAP: Record<string, string> = {
  "ingest:sports":     "/v1/admin/jobs/ingest-sports",
  "ingest:politics":   "/v1/admin/jobs/ingest-politics",
  "ingest:economics":  "/v1/admin/jobs/ingest-economics",
  "ingest:crypto":     "/v1/admin/jobs/ingest-crypto",
  "stale-cleanup":     "/v1/admin/jobs/stale-cleanup",
  "verify:schema":     "/v1/admin/jobs/verify-schema",
  "audit:live":        "/v1/admin/jobs/audit-live",
  "review:crypto":     "/v1/admin/jobs/review-crypto",
  "review:economics":  "/v1/admin/jobs/review-economics",
  "status:digest":     "/v1/admin/jobs/status-digest",
  "benchmark:coverage": "/v1/admin/jobs/benchmark-coverage",
  "health:poll":       "/v1/admin/jobs/health-poll",
  "mm-post-fill-backfill": "/v1/admin/jobs/mm-post-fill-backfill",
  "mm-pnl-snapshot": "/v1/admin/jobs/mm-pnl-snapshot",
  "mm-rotate-tickers": "/v1/admin/jobs/mm-rotate-tickers",
  "mm-stream-heartbeat": "/v1/admin/jobs/mm-stream-heartbeat",
};

serve(async (req: Request) => {
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
    // Fastify rejects POST with Content-Type: application/json and an empty body
    // (FST_ERR_CTP_EMPTY_JSON_BODY). Send "{}" so every admin job route accepts the call.
    /** @type {Record<string,string>} */
    const fwdHeaders: Record<string, string> = {
      "x-pmci-api-key": PMCI_API_KEY,
      "Content-Type": "application/json",
    };
    if (PMCI_ADMIN_KEY) fwdHeaders["x-pmci-admin-key"] = PMCI_ADMIN_KEY;

    const res = await fetch(targetUrl, {
      method: "POST",
      headers: fwdHeaders,
      body: "{}",
    });
    const result = await res.json();
    console.log(`[pmci-job-runner] job=${job} status=${res.status}`, result);
    // Forward the inner API status to pg_cron so non-2xx (e.g. mm-pnl-snapshot
    // returning 500 when a market's snapshot fails) surfaces as a failed cron run
    // instead of being silently masked by an outer 200.
    return new Response(JSON.stringify({ job, status: res.status, result }), {
      status: res.status >= 200 && res.status < 300 ? 200 : res.status,
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
