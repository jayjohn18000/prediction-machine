/**
 * Core decay-monitor computations for Stream C (cron + tests).
 */

import { computePsi } from "./psi.mjs";
import { ksTwoSampleStatistic } from "./ks.mjs";
import { KSWIN } from "./kswin.mjs";
import { fitLogisticGd, importanceFromWeights } from "./feature-importance.mjs";
import {
  SCANNER_TABLE_BY_INEFFICIENCY,
  numericFeaturesForTable,
} from "./signal-features.mjs";

/**
 * @param {Record<string, unknown>} row
 * @param {string[]} keys
 */
export function rowNumericFeatures(row, keys) {
  return keys.map((k) => {
    const v = row[k];
    const n = v === null || v === undefined ? NaN : Number(v);
    return Number.isFinite(n) ? n : NaN;
  });
}

/**
 * Standardize columns (z-score); omit rows where all features NaN (caller filters).
 *
 * @param {number[][]} Xrows prior rows aligned with keys
 */
export function zScoreColumns(Xrows) {
  if (Xrows.length === 0) return { matrix: [], means: [], stds: [] };
  const d = Xrows[0].length;
  const means = new Array(d).fill(0);
  const counts = new Array(d).fill(0);
  for (const row of Xrows) {
    for (let j = 0; j < d; j++) {
      if (Number.isFinite(row[j])) {
        means[j] += row[j];
        counts[j]++;
      }
    }
  }
  for (let j = 0; j < d; j++) means[j] = counts[j] ? means[j] / counts[j] : 0;
  const vars = new Array(d).fill(0);
  for (const row of Xrows) {
    for (let j = 0; j < d; j++) {
      if (Number.isFinite(row[j])) {
        const z = row[j] - means[j];
        vars[j] += z * z;
      }
    }
  }
  const stds = vars.map((v, j) => Math.sqrt(counts[j] ? v / counts[j] : 0) + 1e-9);
  const matrix = Xrows.map((row) =>
    row.map((val, j) => (Number.isFinite(val) ? (val - means[j]) / stds[j] : 0)),
  );
  return { matrix, means, stds };
}

/**
 * @param {unknown} inefficiencyType
 * @returns {string|null}
 */
export function resolveScannerTable(inefficiencyType) {
  const key = typeof inefficiencyType === "string" ? inefficiencyType.trim() : "";
  return SCANNER_TABLE_BY_INEFFICIENCY[/** @type {keyof typeof SCANNER_TABLE_BY_INEFFICIENCY} */ (key)] ?? null;
}

/**
 * Correctness stream for KSWIN: 1 hit, 0 miss; skip other resolved_outcome values.
 *
 * @param {Record<string, unknown>} row
 * @returns {number|null}
 */
export function correctnessBit(row) {
  const ro = row.resolved_outcome;
  if (ro === "hit") return 1;
  if (ro === "miss") return 0;
  return null;
}

/**
 * @param {{ observed_at?: Date|string }} a
 * @param {{ observed_at?: Date|string }} b
 */
export function byObservedAt(a, b) {
  const ta = new Date(/** @type {string} */ (a.observed_at)).getTime();
  const tb = new Date(/** @type {string} */ (b.observed_at)).getTime();
  return ta - tb;
}

/**
 * Compute PSI/KS maps, weighted drift, KSWIN alarm for one hypothesis payload.
 *
 * @param {object} params
 * @param {Record<string, unknown>[]} params.resolvedRows sorted by observed_at, with resolved_at set
 * @param {string} params.scannerTable e.g. scanner_informational_lag_signals
 * @param {Record<string, number>|null} params.featureImportance from hypotheses.feature_importance or null
 * @param {number} params.featureImportanceN hypotheses.feature_importance_n
 * @param {{ alpha?: number; windowSize?: number; statSize?: number; seed?: number }} params.kswinOpts
 * @param {Date} [params.anchorNow] clocks for placeholder windows when &lt;30 hit/miss rows
 */
export function computeDecayMetrics({
  resolvedRows,
  scannerTable,
  featureImportance,
  featureImportanceN,
  kswinOpts = {},
  anchorNow = new Date(),
}) {
  const features = numericFeaturesForTable(scannerTable);
  /** @type {Record<string, number>} */
  const psiPerFeature = {};
  /** @type {Record<string, number>} */
  const ksPerFeature = {};

  let weightedDrift = 0;
  let streamingKswinAlarm = false;

  const hitMissRows = resolvedRows.filter((r) => correctnessBit(r) !== null).slice().sort(byObservedAt);

  const refWindowEndIdx = Math.floor(hitMissRows.length / 2);
  const refRows = hitMissRows.slice(0, refWindowEndIdx);
  const curRows = hitMissRows.slice(refWindowEndIdx);

  const placeholderWindows = () => {
    const nowMs = anchorNow.getTime();
    const seven = 7 * 86400000;
    return {
      refWindowStart: new Date(nowMs - seven),
      refWindowEnd: new Date(nowMs - seven / 2),
      curWindowStart: new Date(nowMs - seven / 2),
      curWindowEnd: anchorNow,
    };
  };

  let refWindowStart;
  let refWindowEnd;
  let curWindowStart;
  let curWindowEnd;

  if (hitMissRows.length === 0) {
    ({ refWindowStart, refWindowEnd, curWindowStart, curWindowEnd } = placeholderWindows());
  } else {
    const firstTs = new Date(/** @type {string} */ (hitMissRows[0].observed_at));
    const lastTs = new Date(/** @type {string} */ (hitMissRows[hitMissRows.length - 1].observed_at));
    refWindowStart = firstTs;
    refWindowEnd = refRows.length
      ? new Date(/** @type {string} */ (refRows[refRows.length - 1].observed_at))
      : firstTs;
    curWindowStart = curRows.length
      ? new Date(/** @type {string} */ (curRows[0].observed_at))
      : refWindowEnd;
    curWindowEnd = lastTs;
  }

  if (hitMissRows.length < 30) {
    ({ refWindowStart, refWindowEnd, curWindowStart, curWindowEnd } = placeholderWindows());
    return {
      psiPerFeature,
      ksPerFeature,
      weightedDrift: 0,
      streamingKswinAlarm: false,
      refWindowStart,
      refWindowEnd,
      curWindowStart,
      curWindowEnd,
      nResolvedHitMiss: hitMissRows.length,
    };
  }

  for (const col of features) {
    const refVals = refRows.flatMap((r) => {
      const v = Number(r[col]);
      return Number.isFinite(v) ? [v] : [];
    });
    const curVals = curRows.flatMap((r) => {
      const v = Number(r[col]);
      return Number.isFinite(v) ? [v] : [];
    });
    const psi = computePsi(refVals, curVals, 10);
    const ks =
      refVals.length && curVals.length ? ksTwoSampleStatistic(refVals, curVals) : 0;
    if (psi !== null && Number.isFinite(psi)) psiPerFeature[col] = psi;
    ksPerFeature[col] = ks;
  }

  const psiCols = Object.keys(psiPerFeature).filter((k) => Number.isFinite(psiPerFeature[k]));
  const uniformPrior = !featureImportance || (featureImportanceN ?? 0) < 50 || psiCols.length === 0;
  if (uniformPrior) {
    const vals = psiCols.map((k) => psiPerFeature[k]);
    weightedDrift = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  } else {
    let num = 0;
    let den = 0;
    for (const col of psiCols) {
      const w = Math.abs(Number(featureImportance?.[col] ?? 0));
      num += psiPerFeature[col] * w;
      den += w;
    }
    weightedDrift = den > 0 ? num / den : 0;
  }

  const kswin = new KSWIN({
    alpha: kswinOpts.alpha ?? 0.005,
    windowSize: kswinOpts.windowSize ?? 100,
    statSize: kswinOpts.statSize ?? 30,
    seed: kswinOpts.seed ?? 42,
  });
  for (const row of hitMissRows) {
    const bit = correctnessBit(row);
    if (bit === null) continue;
    kswin.update(bit);
    if (kswin.drift_detected) streamingKswinAlarm = true;
  }

  return {
    psiPerFeature,
    ksPerFeature,
    weightedDrift,
    streamingKswinAlarm,
    refWindowStart,
    refWindowEnd,
    curWindowStart,
    curWindowEnd,
    nResolvedHitMiss: hitMissRows.length,
  };
}

/**
 * Fit logistic regression on resolved hit/miss rows; returns importance dict + n.
 *
 * @param {Record<string, unknown>[]} resolvedHitMissRows
 * @param {string[]} featureKeys
 */
export function computeFeatureImportanceFit(resolvedHitMissRows, featureKeys) {
  const xsRaw = resolvedHitMissRows.map((r) =>
    featureKeys.map((k) => {
      const v = Number(r[k]);
      return Number.isFinite(v) ? v : NaN;
    }),
  );
  const y = resolvedHitMissRows.map((r) => (r.resolved_outcome === "hit" ? 1 : 0));
  const { matrix } = zScoreColumns(xsRaw);
  const { weights } = fitLogisticGd(matrix, y, { learningRate: 0.08, iterations: 4000 });
  return {
    importance: importanceFromWeights(featureKeys, weights),
    n: resolvedHitMissRows.length,
  };
}
