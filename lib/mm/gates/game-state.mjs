/**
 * NBA play-by-play pull gate (defensive). Uses static win-probability marginal weights
 * inspired by sportsdataverse/hoopR WPA tables (snapshot in hoopR-coefficients.json — no R dependency).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {Record<string, number>} */
let coeffCache = null;
export function loadHoopRCoefficients() {
  if (coeffCache) return coeffCache;
  const raw = readFileSync(join(__dirname, "hoopR-coefficients.json"), "utf8");
  coeffCache = /** @type {Record<string, number>} */ (JSON.parse(raw));
  return coeffCache;
}

/**
 * Marginal win-prob impact for an NBA action type (relative units; scaled vs baseline).
 * @param {string} actionType
 * @param {Record<string, number>} coef
 */
export function eventWpDelta(actionType, coef) {
  const k = String(actionType ?? "default").toUpperCase();
  for (const [prefix, w] of Object.entries(coef)) {
    if (k.includes(prefix.toUpperCase())) return w;
  }
  return coef.default ?? 0.001;
}

/**
 * Approximate |dWP/dt| from last `window` events using uniform time spacing (play clock not modeled v1).
 *
 * @param {object[]} actions from NBA stats `plays[]` or `actions[]`
 * @param {number} window
 */
export function computeAbsDwpDt(actions, window = 8) {
  const coef = loadHoopRCoefficients();
  const arr = Array.isArray(actions) ? actions : [];
  const slice = arr.slice(-window);
  if (slice.length < 2) return 0;
  let sum = 0;
  for (const a of slice) {
    const t = a?.actionType ?? a?.description ?? "";
    sum += Math.abs(eventWpDelta(t, coef));
  }
  return sum / Math.max(1, slice.length - 1);
}

/**
 * @param {{ p75Baseline?: number, window?: number }} [opts]
 */
export async function gameStatePullCheck(market, fetchImpl = globalThis.fetch, opts = {}) {
  const enabled = market?.game_state_pull_enabled === true;
  if (!enabled) return { pull: false, until: null, reason: "disabled" };

  const gameId = market?.nba_game_id != null ? String(market.nba_game_id) : null;
  if (!gameId) return { pull: false, until: null, reason: "no_game_id" };

  const baseline = Number(opts.p75Baseline ?? process.env.MM_NBA_DWP_DT_P75 ?? 0.08);
  const url = `https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${gameId}.json`;

  /** @type {Response} */
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return { pull: false, until: null, reason: `http_${res.status}` };

  const j = await res.json();
  const actions = j?.game?.actions ?? j?.actions ?? [];
  const dwp = computeAbsDwpDt(actions, opts.window ?? 8);
  if (dwp > baseline) {
    const until = new Date(Date.now() + 60_000).toISOString();
    return { pull: true, until, reason: "dwp_dt_spike", dwp, baseline };
  }
  return { pull: false, until: null, reason: "ok", dwp, baseline };
}

export function shouldSkipTickForGamePull(pullResult, nowMs = Date.now()) {
  if (!pullResult?.pull) return false;
  if (pullResult.until) {
    const t = Date.parse(pullResult.until);
    if (Number.isFinite(t) && nowMs < t) return true;
  }
  return pullResult.pull === true;
}
