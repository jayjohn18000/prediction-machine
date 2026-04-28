/**
 * Client order id (Contract R9): mm-<ticker>-<side>-<unix_ms_5s>-<rand4>
 * Idempotent retries within the same 5s bucket reuse the same id (Kalshi idempotency).
 */
import crypto from "node:crypto";

/** @param {number} [epochMs=Date.now()] */
export function unixMs5s(epochMs = Date.now()) {
  return Math.floor(epochMs / 5000) * 5000;
}

/** @returns {string} four lowercase hex chars */
export function randomHex4() {
  return crypto.randomBytes(2).toString("hex").slice(0, 4);
}

/** @typedef {'yes_buy'|'yes_sell'|'no_buy'|'no_sell'} MmOrderSide */

/**
 * @param {object} p
 * @param {string} p.ticker Kalshi market ticker (may contain hyphens)
 * @param {MmOrderSide} p.side MM side discriminator
 * @param {number} [p.now] epoch ms
 * @returns {string}
 */
export function formatClientOrderId({ ticker, side, now = Date.now() }) {
  const u = unixMs5s(now);
  return `mm-${ticker}-${side}-${u}-${randomHex4()}`;
}

/** Maps `${ticker}\0${side}\0${unix_ms_5s}` -> client_order_id for retry reuse (R9). */
const bucketMemo = new Map();

/**
 * Create a new client_order_id, or reuse the prior one for the same (ticker, side)
 * bucket when reuseRetry is true (network replay without duplicating liquidity).
 *
 * @param {object} p
 * @param {string} p.ticker
 * @param {MmOrderSide} p.side
 * @param {number} [p.now]
 * @param {boolean} [p.reuseRetry] if true and this bucket exists, return existing id
 * @returns {string}
 */
export function nextClientOrderId({ ticker, side, now = Date.now(), reuseRetry = false }) {
  const bucket = unixMs5s(now);
  const key = `${ticker}\0${side}\0${bucket}`;
  if (reuseRetry && bucketMemo.has(key)) {
    return bucketMemo.get(key);
  }
  const id = formatClientOrderId({ ticker, side, now: bucket });
  bucketMemo.set(key, id);
  return id;
}

/** Testing / controlled runs — clear memoized ids. */
export function clearClientOrderIdBucketMemo() {
  bucketMemo.clear();
}
