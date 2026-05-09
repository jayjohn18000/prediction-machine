import { IProtection } from "./IProtection.mjs";

/** @typedef {{ side: string, observed_at?: Date|string, observedAtMs?: number }} RecentFill */

/**
 * 3 same-side fills inside windowMinutes → cooldown_10min for that market.
 */
export class CooldownAfterOneSidedFills extends IProtection {
  /** @param {{ consecutive?: number, windowMinutes?: number }} [opts] */
  constructor(opts = {}) {
    super();
    this.consecutive = Math.max(2, Math.floor(Number(opts.consecutive) || 3));
    this.windowMinutes = Math.max(1, Math.floor(Number(opts.windowMinutes) || 5));
  }

  /** @param {RecentFill[]} fills newest first */
  fillsInWindow(fills, nowMs) {
    const win = this.windowMinutes * 60_000;
    return fills.filter((f) => {
      const t =
        f.observedAtMs != null
          ? Number(f.observedAtMs)
          : f.observed_at
            ? new Date(f.observed_at).getTime()
            : nowMs;
      return nowMs - t <= win;
    });
  }

  /** @param {Record<string, unknown>} state */
  stopPerMarket(state, marketTicker) {
    const nowMs = Number(state?.nowMs ?? Date.now());
    const need = Math.max(
      2,
      Math.floor(Number(state.cooldownAfterConsecutiveSameSide ?? this.consecutive) || 3),
    );
    /** @type {Record<string, RecentFill[]>} */
    const by = /** @type {any} */ (state.recentFillsByTicker) ?? {};
    const fills = this.fillsInWindow(by[marketTicker] ?? [], nowMs);
    if (fills.length < need) return false;
    const firstSide = String(fills[0]?.side ?? "");
    if (!firstSide) return false;
    const slice = fills.slice(0, need);
    if (slice.every((f) => String(f.side) === firstSide)) {
      return { stop: "cooldown_10min", reason: "three_same_side_fills" };
    }
    return false;
  }
}
