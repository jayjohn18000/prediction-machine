/**
 * retry.mjs — Exponential backoff retry and fetch timeout helpers.
 *
 * Exports:
 *   retry(fn, options)              — retry an async function with backoff
 *   fetchWithTimeout(url, opts, ms) — fetch with AbortController timeout
 */

/**
 * Retry an async function with exponential backoff and full jitter.
 *
 * @param {() => Promise<any>} fn - async function to attempt
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=3]   - total attempts (1 = no retry)
 * @param {number} [opts.baseDelayMs=500] - base delay before first retry
 * @param {number} [opts.factor=2]        - backoff multiplier per attempt
 * @param {boolean} [opts.jitter=true]    - apply full jitter (random 0..cap)
 * @param {(err: Error) => boolean} [opts.isRetriable] - return false to abort immediately
 * @returns {Promise<any>}
 */
export async function retry(fn, opts = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 500,
    factor = 2,
    jitter = true,
    isRetriable = () => true,
  } = opts;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts || !isRetriable(err)) throw err;
      const cap = baseDelayMs * Math.pow(factor, attempt - 1);
      const delay = jitter ? Math.random() * cap : cap;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Fetch with an AbortController-based timeout.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}
