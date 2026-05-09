#!/usr/bin/env node
/**
 * Stream C — nightly decay monitor: PSI/KS + KSWIN + logistic feature importance.
 * Env: DATABASE_URL (service-role Postgres URL).
 *
 * Invoked by `POST /v1/admin/jobs/scanner-decay-nightly` (pmci-job-runner → pmci-api).
 */

import { createPgClient } from "../../lib/mm/order-store.mjs";
import { loadEnv } from "../../src/platform/env.mjs";
import {
  computeDecayMetrics,
  computeFeatureImportanceFit,
  correctnessBit,
  resolveScannerTable,
  byObservedAt,
} from "../../lib/scanner/decay/run-decay-core.mjs";
import { numericFeaturesForTable } from "../../lib/scanner/decay/signal-features.mjs";

/** @type {Set<string>} */
const ALLOWED_SIGNAL_TABLES = new Set([
  "scanner_informational_lag_signals",
  "scanner_structural_signals",
  "scanner_behavioral_signals",
  "scanner_analytical_signals",
  "scanner_capacity_signals",
  "scanner_resolution_rule_signals",
]);

/**
 * @param {import("pg").Client} client
 * @param {object} payload
 */
async function upsertDecayRow(client, payload) {
  const q = `
    INSERT INTO pmci.hypothesis_decay_state (
      hypothesis_id,
      ref_window_start, ref_window_end,
      current_window_start, current_window_end,
      psi_per_feature, ks_per_feature,
      weighted_drift, streaming_kswin_alarm,
      computed_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6::jsonb, $7::jsonb,
      $8, $9,
      now()
    )
    ON CONFLICT (hypothesis_id) DO UPDATE SET
      ref_window_start = EXCLUDED.ref_window_start,
      ref_window_end = EXCLUDED.ref_window_end,
      current_window_start = EXCLUDED.current_window_start,
      current_window_end = EXCLUDED.current_window_end,
      psi_per_feature = EXCLUDED.psi_per_feature,
      ks_per_feature = EXCLUDED.ks_per_feature,
      weighted_drift = EXCLUDED.weighted_drift,
      streaming_kswin_alarm = EXCLUDED.streaming_kswin_alarm,
      computed_at = EXCLUDED.computed_at
  `;
  await client.query(q, [
    payload.hypothesisId,
    payload.refWindowStart,
    payload.refWindowEnd,
    payload.curWindowStart,
    payload.curWindowEnd,
    JSON.stringify(payload.psiPerFeature),
    JSON.stringify(payload.ksPerFeature),
    payload.weightedDrift,
    payload.streamingKswinAlarm,
  ]);
}

/**
 * @param {import("pg").Client} client
 */
export async function runDecayMonitorCron(client) {
  const anchorNow = new Date();
  const hypRes = await client.query(`
    SELECT id, inefficiency_type, feature_importance, feature_importance_n
    FROM pmci.hypotheses
    WHERE status IN ('live', 'testing')
  `);

  let decayRowsWritten = 0;

  for (const h of hypRes.rows) {
    const table = resolveScannerTable(h.inefficiency_type);
    if (!table || !ALLOWED_SIGNAL_TABLES.has(table)) {
      console.warn(
        `[decay-cron] skip hypothesis ${h.id}: unsupported inefficiency_type=${h.inefficiency_type}`,
      );
      continue;
    }

    const sigRes = await client.query(
      `
      SELECT *
      FROM pmci.${table}
      WHERE hypothesis_id = $1 AND resolved_at IS NOT NULL
      ORDER BY observed_at ASC
      `,
      [h.id],
    );

    const resolvedRows = sigRes.rows;
    const fi =
      h.feature_importance && typeof h.feature_importance === "object"
        ? /** @type {Record<string, number>} */ (h.feature_importance)
        : null;

    const metrics = computeDecayMetrics({
      resolvedRows,
      scannerTable: table,
      featureImportance: fi,
      featureImportanceN: Number(h.feature_importance_n ?? 0),
      anchorNow,
    });

    await upsertDecayRow(client, {
      hypothesisId: h.id,
      refWindowStart: metrics.refWindowStart,
      refWindowEnd: metrics.refWindowEnd,
      curWindowStart: metrics.curWindowStart,
      curWindowEnd: metrics.curWindowEnd,
      psiPerFeature: metrics.psiPerFeature,
      ksPerFeature: metrics.ksPerFeature,
      weightedDrift: Number(metrics.weightedDrift.toFixed(6)),
      streamingKswinAlarm: metrics.streamingKswinAlarm,
    });
    decayRowsWritten += 1;
  }

  let featureImportanceUpdates = 0;

  for (const h of hypRes.rows) {
    const table = resolveScannerTable(h.inefficiency_type);
    if (!table || !ALLOWED_SIGNAL_TABLES.has(table)) continue;

    const sigRes = await client.query(
      `
      SELECT *
      FROM pmci.${table}
      WHERE hypothesis_id = $1 AND resolved_at IS NOT NULL
      ORDER BY observed_at ASC
      `,
      [h.id],
    );

    const hitMiss = sigRes.rows.filter((r) => correctnessBit(r) !== null).sort(byObservedAt);
    if (hitMiss.length < 50) continue;

    const keys = numericFeaturesForTable(table);
    const { importance, n } = computeFeatureImportanceFit(hitMiss, keys);
    await client.query(
      `
      UPDATE pmci.hypotheses
      SET feature_importance = $2::jsonb,
          feature_importance_n = $3,
          feature_importance_updated_at = now(),
          feature_importance_method = 'logistic_regression_perm'
      WHERE id = $1
      `,
      [h.id, JSON.stringify(importance), n],
    );
    featureImportanceUpdates += 1;
  }

  return {
    ok: true,
    hypothesesConsidered: hypRes.rows.length,
    decayRowsWritten,
    featureImportanceUpdates,
  };
}

async function main() {
  loadEnv();
  const client = createPgClient();
  await client.connect();
  try {
    const out = await runDecayMonitorCron(client);
    console.log(JSON.stringify(out, null, 2));
    if (!out.ok) process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
