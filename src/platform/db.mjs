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
  const ssl = buildSslOption(options.ssl);

  const config = {
    connectionString,
    max,
    idleTimeoutMillis,
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

