/**
 * Kalshi series / event-level ref for provider_event_map (Phase G).
 * Prefer metadata.series_ticker when present; otherwise first dash segment of provider_market_ref
 * (e.g. KXMLBODDS-25MAY12-NYM → KXMLBODDS).
 */

/**
 * @param {{ provider_market_ref?: string, metadata?: Record<string, unknown> }} pm
 * @returns {string}
 */
export function kalshiSeriesTickerFromMarket(pm) {
  const meta = pm?.metadata;
  const st = meta && typeof meta === "object" ? meta.series_ticker ?? meta.seriesTicker : null;
  if (st != null && String(st).trim()) return String(st).trim();

  const ref = String(pm?.provider_market_ref || "").trim();
  if (!ref) return "";

  const dash = ref.indexOf("-");
  if (dash > 0) return ref.slice(0, dash);

  return ref;
}

/**
 * Stable per-game ref for `provider_event_map` (must be unique per Kalshi game under UNIQUE (provider_id, provider_event_ref)).
 *
 * We intentionally **do not** trust `metadata.event_ticker` alone: it is often series-level (e.g. KXNHL-26) and would
 * collide across games. Prefer parsing `provider_market_ref` when present.
 *
 * Examples:
 * - KXKBOGAME-26APR020530DOOSAM-DOO → KXKBOGAME-26APR020530DOOSAM (two legs share prefix)
 * - KXMLBODDS-25MAY12-NYM-YES → KXMLBODDS-25MAY12-NYM
 * - KXMLBODDS-25MAY12-NYM → unchanged
 */
export function kalshiProviderEventRefFromMarket(pm) {
  const ref = String(pm?.provider_market_ref || "").trim();
  if (ref) {
    const parts = ref.split("-").filter(Boolean);
    if (parts.length <= 1) return ref;

    const head = parts[0].toUpperCase();
    if (head.includes("GAME") && parts.length >= 3) {
      return parts.slice(0, 2).join("-");
    }
    if (parts.length >= 4) {
      return parts.slice(0, 3).join("-");
    }
    if (parts.length === 3) {
      return ref;
    }
    return kalshiSeriesTickerFromMarket(pm);
  }

  const meta = pm?.metadata && typeof pm.metadata === "object" ? pm.metadata : {};
  const ev = meta.event_ticker ?? meta.eventTicker;
  if (ev != null && String(ev).trim()) return String(ev).trim();

  return kalshiSeriesTickerFromMarket(pm);
}
