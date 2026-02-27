import fs from "node:fs";
import path from "node:path";
import pg from "pg";

// Load .env from repo root so DATABASE_URL is set when running e.g. node src/api.mjs
function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  try {
    const env = fs.readFileSync(envPath, "utf8");
    env.split("\n").forEach((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    });
  } catch (_) {}
}
loadEnv();

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Missing DATABASE_URL env var");

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
});

const dbMetrics = {
  startedAt: new Date().toISOString(),
  totalQueries: 0,
  totalErrors: 0,
  timingsMs: [],
};

function recordTiming(ms) {
  dbMetrics.timingsMs.push(ms);
  if (dbMetrics.timingsMs.length > 2000) dbMetrics.timingsMs.shift();
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function getDbMetrics() {
  const timings = dbMetrics.timingsMs;
  const p95 = percentile(timings, 95);
  const avg = timings.length ? timings.reduce((sum, n) => sum + n, 0) / timings.length : null;
  return {
    started_at: dbMetrics.startedAt,
    total_queries: dbMetrics.totalQueries,
    total_errors: dbMetrics.totalErrors,
    sample_size: timings.length,
    p95_ms: p95 == null ? null : Math.round(p95),
    avg_ms: avg == null ? null : Math.round(avg),
  };
}

export async function query(text, params) {
  const started = Date.now();
  dbMetrics.totalQueries += 1;
  try {
    const result = await pool.query(text, params);
    recordTiming(Date.now() - started);
    return result;
  } catch (err) {
    dbMetrics.totalErrors += 1;
    recordTiming(Date.now() - started);
    throw err;
  }
}
