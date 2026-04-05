/**
 * Sports universe ingestion with runtime hardening.
 * Phase E1.5 PART 3: Runtime hardening for sports ingestion.
 *
 * Features:
 * - MAX_RUNTIME_MS: 30-minute ceiling for total ingestion runtime
 * - checkTimeout(label): Throws if runtime exceeds ceiling
 * - seriesRecentlySeen(client, seriesTicker, hoursThreshold): Skip recently processed series
 * - Graceful stop when runtime exceeds ceiling
 */

import {
  createPmciClient,
  getProviderIds,
  ingestProviderMarket,
  addIngestionCounts,
} from "../pmci-ingestion.mjs";

const MAX_RUNTIME_MS = 30 * 60 * 1000;

let runtimeStartMs = null;

/**
 * Initialize the runtime timer. Call this at the start of ingestion.
 */
export function initRuntime() {
  runtimeStartMs = Date.now();
}

/**
 * Get elapsed runtime in milliseconds since initRuntime() was called.
 * @returns {number} Elapsed time in ms, or 0 if not initialized
 */
export function getElapsedMs() {
  if (runtimeStartMs === null) return 0;
  return Date.now() - runtimeStartMs;
}

/**
 * Get remaining runtime in milliseconds before ceiling is reached.
 * @returns {number} Remaining time in ms, or MAX_RUNTIME_MS if not initialized
 */
export function getRemainingMs() {
  return MAX_RUNTIME_MS - getElapsedMs();
}

/**
 * Check if runtime has exceeded the ceiling and throw if so.
 * Use this before expensive operations to fail fast.
 *
 * @param {string} label - Context label for the timeout error message
 * @throws {Error} If runtime exceeds MAX_RUNTIME_MS
 */
export function checkTimeout(label) {
  const elapsedMs = getElapsedMs();
  if (elapsedMs >= MAX_RUNTIME_MS) {
    const elapsedMinutes = Math.round(elapsedMs / 60000);
    throw new Error(
      `Runtime ceiling exceeded at "${label}": ${elapsedMinutes}m elapsed (ceiling: ${MAX_RUNTIME_MS / 60000}m)`,
    );
  }
}

/**
 * Check if runtime is within safe limits (returns true if OK to continue).
 * Does not throw; use for graceful early exit instead of hard failure.
 *
 * @returns {boolean} True if runtime is below ceiling, false otherwise
 */
export function isWithinRuntime() {
  return getElapsedMs() < MAX_RUNTIME_MS;
}

/**
 * Check if a series was recently seen (ingested) within the threshold period.
 * Use this to skip series that were recently processed, avoiding redundant expensive fetches.
 *
 * @param {object} client - Database client (pmciClient)
 * @param {string} seriesTicker - The series ticker to check
 * @param {number} [hoursThreshold=6] - Hours threshold; series seen within this period are "recently seen"
 * @returns {Promise<boolean>} True if series was seen within threshold, false otherwise
 */
export async function seriesRecentlySeen(client, seriesTicker, hoursThreshold = 6) {
  if (!client || !seriesTicker) {
    return false;
  }

  try {
    const result = await client.query(
      `SELECT EXISTS (
         SELECT 1
         FROM pmci.provider_markets pm
         WHERE pm.metadata->>'series_ticker' = $1
           AND pm.last_seen_at > NOW() - INTERVAL '1 hour' * $2
       ) AS recently_seen`,
      [seriesTicker, hoursThreshold],
    );
    return result.rows?.[0]?.recently_seen === true;
  } catch (err) {
    console.warn(
      "sports-universe: seriesRecentlySeen check failed for %s: %s",
      seriesTicker,
      err.message,
    );
    return false;
  }
}

/**
 * Log runtime status for monitoring.
 * @param {string} context - Context string for the log message
 */
export function logRuntimeStatus(context) {
  const elapsedMs = getElapsedMs();
  const remainingMs = getRemainingMs();
  const elapsedMinutes = (elapsedMs / 60000).toFixed(1);
  const remainingMinutes = (remainingMs / 60000).toFixed(1);
  console.log(
    "sports-universe: %s elapsed=%sm remaining=%sm ceiling=%sm",
    context,
    elapsedMinutes,
    remainingMinutes,
    MAX_RUNTIME_MS / 60000,
  );
}

export { MAX_RUNTIME_MS };
