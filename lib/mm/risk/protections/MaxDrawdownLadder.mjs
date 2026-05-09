import { IProtection } from "./IProtection.mjs";

/**
 * Global drawdown from session peak equity: -1% halve, -2% one-sided flatten, -3% halt.
 * `maxDrawdownPctGlobal` from mm_market_config (default 0.03) is the halt line; 2% and 1% are 2/3 and 1/3 of it when != 0.03, else textbook 1/2/3%.
 */
export class MaxDrawdownLadder extends IProtection {
  /** @param {{ maxDrawdownPctGlobal?: number }} [opts] */
  constructor(opts = {}) {
    super();
    this.haltPct = Math.min(0.5, Math.max(0.01, Number(opts.maxDrawdownPctGlobal ?? 0.03)));
  }

  /** @param {Record<string, unknown>} state */
  globalStop(state) {
    const peak = Number(state?.peakEquityCents ?? state?.sessionPeakEquityCents ?? NaN);
    const eq = Number(state?.equityCents ?? NaN);
    if (!Number.isFinite(peak) || peak <= 0 || !Number.isFinite(eq)) return false;
    const dd = (eq - peak) / peak;
    const h = Math.min(
      0.5,
      Math.max(0.01, Number(state?.maxDrawdownPctGlobal ?? this.haltPct) || 0.03),
    );
    const isDefault = h >= 0.029 && h <= 0.031;
    const flatPct = isDefault ? 0.02 : (h * 2) / 3;
    const halfPct = isDefault ? 0.01 : h / 3;
    if (dd <= -h) return { stop: "halt", reason: "drawdown_3pct" };
    if (dd <= -flatPct) return { stop: "one_sided_flatten", reason: "drawdown_2pct" };
    if (dd <= -halfPct) return { stop: "halve_size", reason: "drawdown_1pct" };
    return false;
  }
}
