import { createPool } from "./platform/db.mjs";

let pool = null;

function getPool() {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

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
  const poolInstance = getPool();
  const started = Date.now();
  dbMetrics.totalQueries += 1;
  try {
    const result = await poolInstance.query(text, params);
    recordTiming(Date.now() - started);
    return result;
  } catch (err) {
    dbMetrics.totalErrors += 1;
    recordTiming(Date.now() - started);
    throw err;
  }
}

/**
 * Run `fn` inside a single DB transaction. `fn` receives a `txQuery(text, params)` bound
 * to the dedicated client and tracked in dbMetrics. Commits on success, rolls back on any
 * thrown error. Pass `_pool` in tests to inject a mock pool (test seam only).
 *
 * @param {(txQuery: Function) => Promise<any>} fn
 * @param {{ _pool?: object }} [opts]
 */
export async function withTransaction(fn, { _pool } = {}) {
  const poolInstance = _pool ?? getPool();
  const client = await poolInstance.connect();
  const txQuery = async (text, params) => {
    const started = Date.now();
    dbMetrics.totalQueries += 1;
    try {
      const result = await client.query(text, params);
      recordTiming(Date.now() - started);
      return result;
    } catch (err) {
      dbMetrics.totalErrors += 1;
      recordTiming(Date.now() - started);
      throw err;
    }
  };
  try {
    await client.query('BEGIN');
    const result = await fn(txQuery);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw err;
  } finally {
    client.release();
  }
}
