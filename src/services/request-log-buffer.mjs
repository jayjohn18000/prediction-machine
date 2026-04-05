const REQUEST_LOG_FLUSH_INTERVAL_MS = 2_000;
const REQUEST_LOG_MAX_BUFFER_SIZE = 500;

const requestLogBuffer = [];
let requestLogFlusherStarted = false;
let requestLogDb = null;
let flushPromise = null;
let flushTimer = null;

function buildBulkInsert(records) {
  const values = [];
  const params = [];

  for (const record of records) {
    const offset = params.length;
    values.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`
    );
    params.push(
      record.method,
      record.path,
      record.status,
      record.latency_ms,
      record.api_key_hint,
      record.logged_at ?? new Date()
    );
  }

  return {
    text: `INSERT INTO pmci.request_log (method, path, status, latency_ms, api_key_hint, logged_at)
           VALUES ${values.join(", ")}`,
    params,
  };
}

export function enqueueRequestLog(record) {
  requestLogBuffer.push({
    method: record.method,
    path: record.path,
    status: record.status,
    latency_ms: record.latency_ms,
    api_key_hint: record.api_key_hint ?? null,
    logged_at: record.logged_at ?? new Date(),
  });

  if (requestLogDb && requestLogBuffer.length >= REQUEST_LOG_MAX_BUFFER_SIZE) {
    void flushRequestLogs(requestLogDb);
  }
}

export async function flushRequestLogs(db = requestLogDb) {
  if (!db) return 0;
  if (flushPromise) return flushPromise;
  if (requestLogBuffer.length === 0) return 0;

  const records = requestLogBuffer.splice(0, requestLogBuffer.length);
  const { text, params } = buildBulkInsert(records);

  flushPromise = db
    .query(text, params)
    .then(() => {
      console.log(`[pmci-request-log] flushed ${records.length} logs`);
      return records.length;
    })
    .catch((err) => {
      requestLogBuffer.unshift(...records);
      console.error(`[pmci-request-log] flush failed, re-queued ${records.length} logs:`, err.message);
      return 0;
    })
    .finally(() => {
      flushPromise = null;
    });

  return flushPromise;
}

export function startRequestLogFlusher(db) {
  requestLogDb = db;
  if (!db || requestLogFlusherStarted) return;

  requestLogFlusherStarted = true;
  flushTimer = setInterval(() => {
    void flushRequestLogs(db);
  }, REQUEST_LOG_FLUSH_INTERVAL_MS);

  if (typeof flushTimer.unref === "function") {
    flushTimer.unref();
  }
}
