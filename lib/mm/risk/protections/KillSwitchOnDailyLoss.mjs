import { IProtection } from "./IProtection.mjs";

/**
 * Halt when daily portfolio PnL breaches -daily_loss_limit_cents (already in mm_market_config).
 * Writes mm_kill_switch_events once when crossing.
 */
export class KillSwitchOnDailyLoss extends IProtection {
  /** @param {{ insertKillEvent?: (row: object) => Promise<void>, fired?: Set<string> }} [opts] */
  constructor(opts = {}) {
    super();
    this.insertKillEvent = opts.insertKillEvent;
    this.fired = opts.fired ?? new Set();
  }

  /** @param {Record<string, unknown>} state */
  globalStop(state) {
    const limit = Number(state?.dailyLossLimitCents ?? 0);
    const pnl = Number(state?.portfolioDailyPnLCents ?? 0);
    if (!(limit > 0) || !Number.isFinite(pnl)) return false;
    if (pnl <= -limit) {
      const key = `daily_${limit}_${Math.floor(pnl)}`;
      if (!this.fired.has(key) && this.insertKillEvent) {
        this.fired.add(key);
        void this.insertKillEvent({
          observed_at: new Date(),
          market_id: null,
          reason: "daily_loss_iprotection",
          details: { pnlCents: pnl, limitCents: limit },
        });
      }
      return { stop: "halt", reason: "daily_loss_limit" };
    }
    return false;
  }
}
