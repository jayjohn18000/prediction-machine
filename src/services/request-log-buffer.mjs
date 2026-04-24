const REQUEST_LOG_FLUSH_INTERVAL_MS = 2_000;
// Trigger an extra flush when buffered logs cross this watermark.
const REQUEST_LOG_FLUSH_THRESHOLD = 250;
// Hard cap — above this we drop the oldest buffered record rather than grow
// unbounded. Protects the process if the flusher is wedged or the DB is slow.
const REQUEST_LOG_MAX_BUFFER_SIZE = 500;

const requestLogBuffer = [];
let requestLogFlusherStarted = false;
let requestLogDb = null;
let flushPromise = null;
let flushTimer = null;
let droppedLogCount = 0;

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
  // Drop oldest when buffer is full. Request logs are observability data;
  // losing the oldest few is strictly preferable to growing memory without
  // bound if the flusher has stalled (dead client, slow DB, etc.).
  while (requestLogBuffer.length >= REQUEST_LOG_MAX_BUFFER_SIZE) {
    requestLogBuffer.shift();
    droppedLogCount++;
  }

  requestLogBuffer.push({
    method: record.method,
    path: record.path,
    status: record.status,
    latency_ms: record.latency_ms,
    api_key_hint: record.api_key_hint ?? null,
    logged_at: record.logged_at ?? new Date(),
  });

  if (requestLogDb && requestLogBuffer.length >= REQUEST_LOG_FLUSH_THRESHOLD) {
    void flushRequestLogs(requestLogDb);
  }
}

function isDeadClientError(err) {
  // pg.Client sets _queryable=false after the socket dies and rejects every
  // subsequent query with this exact message. Also catch the usual
  // connection-gone errnos and Postgres terminate codes.
  const msg = err?.message ?? "";
  if (msg.includes("not queryable")) return true;
  if (msg.includes("Connection terminated")) return true;
  const code = err?.code;
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EPIPE") return true;
  if (code === "57P01" || code === "08006" || code === "08003") return true;
  return false;
}

function stopFlusher() {
  requestLogDb = null;
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  requestLogFlusherStarted = false;
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
      if (droppedLogCount > 0) {
        console.warn(`[pmci-request-log] dropped ${droppedLogCount} logs while buffer was full`);
        droppedLogCount = 0;
      }
      console.log(`[pmci-request-log] flushed ${records.length} logs`);
      return records.length;
    })
    .catch((err) => {
      // If the underlying client is dead there is no point re-queueing — every
      // subsequent .query() will reject with the same error and we'll loop
      // forever while the buffer grows. Stop the flusher and drop the batch.
      if (isDeadClientError(err)) {
        console.error(
          `[pmci-request-log] client dead (${err.message}); stopping flusher and dropping ${records.length} buffered logs`
        );
        stopFlusher();
        requestLogBuffer.length = 0;
        return 0;
      }
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
    // Read through requestLogDb so stopFlusher() short-circuits a pending tick.
    void flushRequestLogs();
  }, REQUEST_LOG_FLUSH_INTERVAL_MS);

  if (typeof flushTimer.unref === "function") {
    flushTimer.unref();
  }
}
