import { IProtection } from "./IProtection.mjs";

/** Pull (global) when Kalshi WS / snapshot lag exceeds threshold. */
export class LatencyGate extends IProtection {
  /** @param {{ maxLagMs?: number }} [opts] */
  constructor(opts = {}) {
    super();
    const raw =
      typeof globalThis.process !== "undefined" ? globalThis.process.env?.MM_LATENCY_GATE_MS : undefined;
    const env = raw != null && String(raw).trim() !== "" ? Number(raw) : NaN;
    this.maxLagMs = Number.isFinite(env) && env > 0 ? env : Number(opts.maxLagMs ?? 2000);
  }

  /** @param {Record<string, unknown>} state */
  globalStop(state) {
    const lag = Number(state?.kalshiWsLagMs ?? state?.snapshotLagMs ?? 0);
    if (Number.isFinite(lag) && lag > this.maxLagMs) {
      return { stop: "cooldown_10min", reason: "latency_ws_lag" };
    }
    return false;
  }
}
