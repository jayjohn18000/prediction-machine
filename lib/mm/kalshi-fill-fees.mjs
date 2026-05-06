/**
 * Map Kalshi GET /portfolio/fills elements → pmci.mm_fills observed fee columns.
 *
 * Public Fill schema documents `fee_cost` (aggregate, dollars string) and `is_taker`.
 * When Kalshi omits per-component fields, we derive lane-13 breakdown from those two:
 * - Taker: net maps to trade fee (signed; aligns with Kalshi `fee_cost`).
 * - Maker: negative net → rebate received (positive `kalshi_rebate_cents`); positive net → trade fee.
 *
 * When explicit breakdown keys exist on the wire, they win (see optionalFeeCents).
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
 * Best-effort explicit trade / rounding / rebate from the fill payload.
 *
 * @param {Record<string, unknown>} f
 */
function explicitFeeBreakdown(f) {
  const kalshi_trade_fee_cents =
    optionalFeeCents(f, "trade_fee_dollars") ??
    optionalFeeCents(f, "trade_fee") ??
    optionalFeeCents(f, "taker_fee_dollars") ??
    optionalFeeCents(f, "taker_fee_cost") ??
    null;
  const kalshi_rounding_fee_cents =
    optionalFeeCents(f, "rounding_fee_dollars") ??
    optionalFeeCents(f, "rounding_fee") ??
    optionalFeeCents(f, "rounding_fee_cost") ??
    null;
  const kalshi_rebate_cents =
    optionalFeeCents(f, "rebate_dollars") ??
    optionalFeeCents(f, "rebate") ??
    optionalFeeCents(f, "maker_rebate_dollars") ??
    optionalFeeCents(f, "maker_rebate") ??
    null;
  return { kalshi_trade_fee_cents, kalshi_rounding_fee_cents, kalshi_rebate_cents };
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
  const rawNet =
    /** @type {Record<string, unknown>} */ (f).fee_cost ??
    /** @type {Record<string, unknown>} */ (f).fees_total_dollars;
  const kalshi_net_fee_cents = kalshiDollarsStringToFeeCents(rawNet);

  /** @type {Record<string, unknown>} */
  const rec = f;
  let { kalshi_trade_fee_cents, kalshi_rounding_fee_cents, kalshi_rebate_cents } =
    explicitFeeBreakdown(rec);

  const isTaker = rec.is_taker === true;

  if (
    kalshi_net_fee_cents != null &&
    kalshi_trade_fee_cents == null &&
    kalshi_rebate_cents == null &&
    kalshi_rounding_fee_cents == null
  ) {
    if (isTaker) {
      kalshi_trade_fee_cents = kalshi_net_fee_cents;
    } else {
      if (kalshi_net_fee_cents < 0) {
        kalshi_rebate_cents = -kalshi_net_fee_cents;
      } else if (kalshi_net_fee_cents > 0) {
        kalshi_trade_fee_cents = kalshi_net_fee_cents;
      } else {
        kalshi_trade_fee_cents = 0;
        kalshi_rebate_cents = 0;
      }
    }
  }

  return {
    kalshi_net_fee_cents,
    kalshi_trade_fee_cents,
    kalshi_rounding_fee_cents,
    kalshi_rebate_cents,
  };
}
