import pg from 'pg';
import { loadEnv } from './env.mjs';

const { Pool, Client } = pg;

function getDatabaseUrl() {
  loadEnv();
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error('Missing DATABASE_URL env var');
  }
  return url;
}

function buildSslOption(explicit) {
  if (explicit !== undefined) return explicit;
  const flag = process.env.PG_SSL;
  if (flag === '0') return false;
  if (flag === '1') return { rejectUnauthorized: false };
  return undefined;
}

export function createPool(options = {}) {
  const connectionString = options.connectionString ?? getDatabaseUrl();
  const max = options.max ?? Number(process.env.PG_POOL_MAX ?? '10');
  const idleTimeoutMillis = options.idleTimeoutMillis ?? 30_000;
  // Without these, a dead TCP socket or unresponsive backend causes pool.query()
  // to hang indefinitely — we saw /v1/health/freshness wedge Fly health checks
  // because the underlying pg client had no deadline. Values chosen to be well
  // above real query latency (~50ms) but short enough to fail fast.
  const connectionTimeoutMillis =
    options.connectionTimeoutMillis ?? Number(process.env.PG_CONNECTION_TIMEOUT_MS ?? '5000');
  const statementTimeoutMs =
    options.statement_timeout ?? Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? '8000');
  const queryTimeoutMs =
    options.query_timeout ?? Number(process.env.PG_QUERY_TIMEOUT_MS ?? '10000');
  const ssl = buildSslOption(options.ssl);

  const config = {
    connectionString,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    statement_timeout: statementTimeoutMs,
    query_timeout: queryTimeoutMs,
  };

  if (ssl !== undefined) {
    config.ssl = ssl;
  }

  const pool = new Pool(config);
  // Prevent unhandled 'error' events on idle pool clients from crashing the process.
  // Transient ETIMEDOUT / ECONNRESET on idle connections are expected; the pool
  // will reconnect automatically on the next query.
  pool.on('error', (err) => {
    console.error('[pmci-pool] idle client error (pool will reconnect):', err.message);
  });
  return pool;
}

export function createClient(options = {}) {
  const connectionString = options.connectionString ?? getDatabaseUrl();
  const ssl = buildSslOption(options.ssl);

  const config = { connectionString };
  if (ssl !== undefined) {
    config.ssl = ssl;
  }

  return new Client(config);
}

