/**
 * MM fair-value v0 — Kalshi midpoint → optional Polymarket blend → half-life EMA (plan §`lib/mm/fair-value.mjs`).
 *
 * Audit mapping (summarized inline; match spec doc where provided):
 * - **R15** — 30s half-life EMA smoothing on blended mid (`HALF_LIFE_MS = 30000`).
 * - **R16** — Liquidity-weighted blend `fair_blend = (L_k × mid_k + L_p × mid_p) / (L_k + L_p)` when both legs exist.
 * - **R6** — Cold-start until `confidence` rises; first observation seeds EMA (`ema = blended`).
 */

/** @readonly */
export const HALF_LIFE_MS = 30_000;

/**
 * Liquidity weights default to neutral when missing (Kalshi-only path).
 *
 * @param {number|null|undefined} midKalshiCents
 * @param {number|null|undefined} midPolyCents 0–100 YES-implied cents
 * @param {number|null|undefined} lk
 * @param {number|null|undefined} lp
 * @returns {number|null} blended mid cents
 */
export function blendKalshiPolyMid(midKalshiCents, midPolyCents, lk, lp) {
  if (midKalshiCents == null || !Number.isFinite(Number(midKalshiCents))) return null;
  const mk = Number(midKalshiCents);
  if (midPolyCents != null && Number.isFinite(Number(midPolyCents))) {
    const mp = Number(midPolyCents);
    const Lk = lk != null && lk > 0 ? Number(lk) : 1;
    const Lp = lp != null && lp > 0 ? Number(lp) : 1;
    return (Lk * mk + Lp * mp) / (Lk + Lp);
  }
  return mk;
}

/**
 * Discrete EMA step with exponential decay matching continuous half-life.
 * Uses `alpha = 1 - exp(-ln(2) * dt / halfLife)` per step.
 *
 * @param {{ emaCents?: number|null, lastEmitMs?: number|null, updates?: number }} state
 */
export function emaHalfLifeStep(state, blendedMidCents, nowMs, dtMs = null) {
  if (blendedMidCents == null || !Number.isFinite(blendedMidCents)) return { ...state };

  let dt =
    dtMs ??
    (state.lastEmitMs != null && state.lastEmitMs > 0
      ? Math.max(0, nowMs - Number(state.lastEmitMs))
      : 250);

  if (state.emaCents == null || !Number.isFinite(Number(state.emaCents))) {
    /** R6 cold-start seed */
    return {
      emaCents: blendedMidCents,
      lastEmitMs: nowMs,
      updates: (state.updates ?? 0) + 1,
      confidence: 0.08,
      stalenessMs: dt,
    };
  }

  const alpha =
    dt <= 0 ? 0 : 1 - Math.exp((-Math.LN2 * dt) / HALF_LIFE_MS);
  const prev = Number(state.emaCents);
  const ema = prev + alpha * (blendedMidCents - prev);
  const updates = (state.updates ?? 0) + 1;
  const confidence = Math.min(1, updates / 12);
  return {
    emaCents: Math.round(ema * 1000) / 1000,
    lastEmitMs: nowMs,
    updates,
    confidence,
    stalenessMs: dt,
  };
}

/**
 * @param {object} p
 * @param {{ emaCents?: number|null, lastEmitMs?: number|null, updates?: number }} p.state
 * @param {number} p.midKalshiCents
 * @param {number|null|undefined} [p.midPolyCents]
 * @param {number|null|undefined} [p.weightKalshiLiquidity]
 * @param {number|null|undefined} [p.weightPolyLiquidity]
 * @param {number} p.nowMs
 * @param {number|null} [p.dtMs]
 */
export function updateFairValue(p) {
  const blended = blendKalshiPolyMid(
    p.midKalshiCents,
    p.midPolyCents,
    p.weightKalshiLiquidity,
    p.weightPolyLiquidity,
  );
  const st = p.state ?? {};
  if (blended == null || !Number.isFinite(blended)) {
    const fv = Number(st.emaCents ?? NaN);
    return {
      fair_value_cents: fv,
      confidence: Number(st.confidence ?? 0),
      staleness_ms: p.midObservedMs != null ? Math.max(0, Number(p.nowMs) - Number(p.midObservedMs)) : Number(st.staleMs ?? 0),
      blended_mid_cents: blended,
      raw: { skipped: true },
      carry: {
        emaCents: st.emaCents ?? null,
        lastEmitMs: st.lastEmitMs ?? null,
        updates: st.updates ?? 0,
        confidence: st.confidence ?? 0,
      },
    };
  }

  const next = emaHalfLifeStep(st, blended, p.nowMs, p.dtMs ?? undefined);
  if (next.emaCents == null) {
    return {
      fair_value_cents: NaN,
      confidence: 0,
      staleness_ms: Number(next.stalenessMs ?? NaN),
      blended_mid_cents: blended,
      raw: {},
      carry: { emaCents: null, lastEmitMs: null, updates: 0, confidence: 0 },
    };
  }

  /** R6 staleness tracked from last inbound mid tick */
  const stalenessMs =
    p.midObservedMs != null && p.nowMs != null ? Math.max(0, p.nowMs - p.midObservedMs) : Number(next.stalenessMs ?? 0);

  return {
    fair_value_cents: Number(next.emaCents),
    confidence: next.confidence ?? 0,
    staleness_ms: stalenessMs,
    blended_mid_cents: blended,
    raw: { ema_updates: next.updates },
    carry: {
      emaCents: next.emaCents,
      lastEmitMs: next.lastEmitMs,
      updates: next.updates,
      confidence: next.confidence ?? 0,
    },
  };
}

export function createFairValueMarketState() {
  return {};
}
