/**
 * Map Kalshi GET /portfolio/fills elements → pmci.mm_fills observed fee columns.
 *
 * Public OpenAPI documents `fee_cost` (aggregate fee, dollars string). Separate
 * trade / rounding / rebate lines are not in that schema; we populate breakdown
 * columns only when Kalshi adds matching keys on the wire.
 */

/**
 * @param {unknown} dollarsStr unknown Kalshi FixedPointDollars string
 * @returns {number|null} cents (numeric), null if missing/invalid
 */
export function kalshiDollarsStringToFeeCents(dollarsStr) {
  if (dollarsStr == null || dollarsStr === "") return null;
  const n = Number.parseFloat(String(dollarsStr));
  if (!Number.isFinite(n)) return null;
  return n * 100;
}

/**
 * @param {object} f fill json
 * @param {string} key snake_case key on fill object
 */
function optionalFeeCents(f, key) {
  const v = /** @type {Record<string, unknown>} */ (f)[key];
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v * 100 : null;
  return kalshiDollarsStringToFeeCents(v);
}

/**
 * @param {object} f Kalshi fill JSON
 * @returns {{
 *   kalshi_net_fee_cents: number|null,
 *   kalshi_trade_fee_cents: number|null,
 *   kalshi_rounding_fee_cents: number|null,
 *   kalshi_rebate_cents: number|null,
 * }}
 */
export function observedFeesFromKalshiFill(f) {
  /** Net / aggregate — OpenAPI `fee_cost`; tolerate aliases if Kalshi adds them. */
  const rawNet = /** @type {Record<string, unknown>} */ (f).fee_cost;
  const kalshi_net_fee_cents = kalshiDollarsStringToFeeCents(rawNet);

  /* Breakdown: not in public Fill schema — wire when present (names are guesses). */
  const kalshi_trade_fee_cents =
    optionalFeeCents(f, "trade_fee_dollars") ??
    optionalFeeCents(f, "trade_fee") ??
    null;
  const kalshi_rounding_fee_cents =
    optionalFeeCents(f, "rounding_fee_dollars") ?? optionalFeeCents(f, "rounding_fee") ?? null;
  const kalshi_rebate_cents =
    optionalFeeCents(f, "rebate_dollars") ?? optionalFeeCents(f, "rebate") ?? null;

  return {
    kalshi_net_fee_cents,
    kalshi_trade_fee_cents,
    kalshi_rounding_fee_cents,
    kalshi_rebate_cents,
  };
}
