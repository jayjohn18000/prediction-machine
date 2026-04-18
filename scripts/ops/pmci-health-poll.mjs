#!/usr/bin/env node
/**
 * Poll PMCI /v1/health/* endpoints and append rows to pmci.health_log.
 * Replaces pg_net enqueue/collect (http_collect_response fails under pg_cron).
 *
 * Env: DATABASE_URL, PMCI_API_KEY required.
 * Base URL: PMCI_API_URL or PMCI_SERVER_URL or https://pmci-api.fly.dev
 *
 * Projection-ready is polled when UTC minute is divisible by 15 (aligned with five-minute cron),
 * or pass --projection to always include it.
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();
const { Client } = pg;

const BASE =
  process.env.PMCI_API_URL?.replace(/\/$/, "") ||
  process.env.PMCI_SERVER_URL?.replace(/\/$/, "") ||
  "https://pmci-api.fly.dev";

const CORE = ["/v1/health/freshness", "/v1/health/slo", "/v1/health/observer"];
const PROJECTION = "/v1/health/projection-ready";

function includeProjection() {
  if (process.argv.includes("--projection")) return true;
  const m = new Date().getUTCMinutes();
  return m % 15 === 0;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const apiKey = process.env.PMCI_API_KEY?.trim();
  if (!databaseUrl) {
    console.error("pmci-health-poll: DATABASE_URL required");
    process.exit(1);
  }
  if (!apiKey) {
    console.error("pmci-health-poll: PMCI_API_KEY required");
    process.exit(1);
  }

  const paths = [...CORE];
  if (includeProjection()) paths.push(PROJECTION);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const path of paths) {
      const url = `${BASE}${path}`;
      const t0 = Date.now();
      let httpStatus = null;
      let payload = {};
      let responseMs = null;
      try {
        const res = await fetch(url, {
          headers: { "x-pmci-api-key": apiKey },
        });
        httpStatus = res.status;
        responseMs = Date.now() - t0;
        const text = await res.text();
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          payload = { _parse_error: true, snippet: text.slice(0, 4000) };
        }
      } catch (e) {
        payload = { error: String(e?.message || e) };
        responseMs = Date.now() - t0;
      }

      const isHealthy = httpStatus === 200;
      await client.query(
        `INSERT INTO pmci.health_log (endpoint, http_status, is_healthy, payload, response_ms)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [path, httpStatus, isHealthy, JSON.stringify(payload), responseMs],
      );
      console.log(
        `[pmci-health-poll] ${path} http=${httpStatus} healthy=${isHealthy} ${responseMs}ms`,
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
