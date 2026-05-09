/**
 * Lightweight WPA helpers for scanner NBA lane (coefficients from hoopR-coefficients.json).
 * Aligns with lib/mm/gates/game-state.mjs marginal weights — not full hoopR inference.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {Record<string, number>|null} */
let _coef = null;

export function loadCoefficients() {
  if (_coef) return _coef;
  const raw = readFileSync(join(__dirname, "../mm/gates/hoopR-coefficients.json"), "utf8");
  _coef = /** @type {Record<string, number>} */ (JSON.parse(raw));
  return _coef;
}

/**
 * Map NBA CDN actionType / description to coefficient bucket (same heuristic as game-state gate).
 * @param {string} actionType
 */
export function coefficientForActionType(actionType) {
  const coef = loadCoefficients();
  const k = String(actionType ?? "default").toUpperCase();
  for (const [prefix, w] of Object.entries(coef)) {
    if (prefix === "default") continue;
    if (k.includes(prefix.toUpperCase())) return w;
  }
  return coef.default ?? 0.012;
}

/**
 * Effective win-probability increment magnitude for an action (always ≥ 0).
 * "WPA" in scanner-plan shorthand — scaled coefficient, not literal WPA from hoopR.
 * @param {string} actionType
 */
export function computeWpaMagnitude(actionType) {
  return Math.abs(coefficientForActionType(actionType));
}

/**
 * Rough live WP for home team in [0,1] from box-style state (v1 heuristic).
 * @param {{ homeScore: number, awayScore: number, period: number }} st
 */
export function liveHomeWinProb(st) {
  const hs = Number(st.homeScore) || 0;
  const as = Number(st.awayScore) || 0;
  const diff = hs - as;
  const pd = Number(st.period) || 1;
  const late = pd >= 4 ? 1.35 : pd >= 3 ? 1.15 : 1.0;
  const logistic = 1 / (1 + Math.exp(-0.12 * diff * late));
  return Math.min(0.995, Math.max(0.005, logistic));
}

/**
 * Whether this action should enter the informational-lag gate set.
 * @param {string} actionType
 */
export function isHighLeverageActionType(actionType) {
  const t = String(actionType ?? "").toLowerCase();
  if (t.includes("period")) return t.includes("end");
  return (
    t.includes("3pt") ||
    t.includes("2pt") ||
    t.includes("layup") ||
    t.includes("dunk") ||
    t === "foul" ||
    t.includes("foul") ||
    t.includes("timeout")
  );
}
