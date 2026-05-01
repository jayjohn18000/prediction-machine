/**
 * Kalshi REST order status → mm_orders.status (subset).
 *
 * @param {string|undefined|null} s
 */
export function mapKalshiOrderStatus(s) {
  const v = String(s ?? "");
  if (v === "resting") return "open";
  if (v === "canceled" || v === "cancelled") return "cancelled";
  if (v === "executed") return "filled";
  return "open";
}
