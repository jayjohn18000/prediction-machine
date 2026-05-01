/**
 * Kalshi fill JSON → MM side / YES price helpers (shared by fill ingest).
 *
 * @param {object} f
 */
export function mapKalshiFillToMmSide(f) {
  const side = String(f.side ?? "");
  const act = String(f.action ?? "");
  if (side === "yes" && act === "buy") return "yes_buy";
  if (side === "yes" && act === "sell") return "yes_sell";
  if (side === "no" && act === "buy") return "no_buy";
  if (side === "no" && act === "sell") return "no_sell";
  return "yes_buy";
}

/**
 * @param {object} f
 */
export function fillYesPriceCents(f) {
  if (String(f.side ?? "") === "yes") return Math.round(Number(f.yes_price_dollars) * 100);
  return Math.round((1 - Number(f.no_price_dollars)) * 100);
}
