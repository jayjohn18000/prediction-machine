/**
 * Hummingbot-style pre-trade size adjust before Kalshi submit.
 *
 * @typedef {{ market_ticker: string, side: string, size_c: number, price_cents?: number, adjustedReason?: string }} OrderCandidate
 * @typedef {import('./protections/IProtection.mjs').IProtection} IProtection
 */

const DEF_MIN = 1;

function minPositionSizeC(state) {
  const m = Number(state?.min_position_size_c ?? process.env.MM_MIN_POSITION_SIZE_C ?? DEF_MIN);
  return Number.isFinite(m) && m > 0 ? Math.floor(m) : DEF_MIN;
}

/**
 * Apply global + per-market protections; shrink size on halve_size; null if blocked.
 *
 * @param {OrderCandidate | null} order
 * @param {Record<string, unknown>} state
 * @param {IProtection[]} protections
 * @returns {OrderCandidate | null}
 */
export function adjustCandidate(order, state, protections) {
  if (!order || !order.market_ticker) return null;
  const minSz = minPositionSizeC(state);
  let size = Math.max(0, Math.floor(Number(order.size_c) || 0));
  if (size < minSz) return null;

  for (const p of protections) {
    const g = p.globalStop?.(state);
    if (g && typeof g === "object" && g.stop === "halt") return null;
    if (g && typeof g === "object" && g.stop === "cooldown_10min") return null;
    if (g && typeof g === "object" && g.stop === "halve_size") {
      size = Math.max(0, Math.floor(size / 2));
      order.adjustedReason = "halve_size_global";
    }
    if (g && typeof g === "object" && g.stop === "one_sided_flatten") {
      const fs = state.flattenSide?.(order.market_ticker);
      if (fs) order.side = fs;
    }

    const m = p.stopPerMarket?.(state, order.market_ticker);
    if (m && typeof m === "object" && m.stop === "halt") return null;
    if (m && typeof m === "object" && m.stop === "cooldown_10min") return null;
    if (m && typeof m === "object" && m.stop === "halve_size") {
      size = Math.max(0, Math.floor(size / 2));
      order.adjustedReason = "halve_size_market";
    }

    const s = p.stopPerSide?.(state, order.market_ticker, order.side);
    if (s && typeof s === "object" && s.stop === "halt") return null;
    if (s && typeof s === "object" && s.stop === "cooldown_10min") return null;
  }

  const remaining = state.dailyBudgetRemainingCents != null ? Number(state.dailyBudgetRemainingCents) : null;
  if (remaining != null && Number.isFinite(remaining) && remaining >= 0) {
    const px = Number(order.price_cents ?? 0);
    if (px > 0) {
      const maxContracts = Math.floor(remaining / px);
      if (size > maxContracts) {
        size = Math.max(0, maxContracts);
        order.adjustedReason = "budget_remaining";
      }
    }
    if (remaining <= 0) return null;
  }

  if (size < minSz) return null;
  return { ...order, size_c: size };
}
