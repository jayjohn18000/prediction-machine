import { IProtection } from "./IProtection.mjs";

/** Halt single market when cumulative loss exceeds cap (cents). */
export class PerMarketLossCap extends IProtection {
  /** @param {{ perMarketLossCapCents?: number }} [opts] */
  constructor(opts = {}) {
    super();
    this.cap = Math.max(1, Number(opts.perMarketLossCapCents ?? 2500));
  }

  /** @param {Record<string, unknown>} state */
  stopPerMarket(state, marketTicker) {
    const map = /** @type {Record<string, number>|undefined} */ (state.marketLossCentsByTicker);
    const v = map?.[marketTicker];
    if (v != null && Number(v) <= -this.cap) {
      return { stop: "halt", reason: "per_market_loss_cap" };
    }
    return false;
  }
}
