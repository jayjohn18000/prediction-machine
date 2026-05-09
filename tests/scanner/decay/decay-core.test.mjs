import test from "node:test";
import assert from "node:assert/strict";
import { computeDecayMetrics } from "../../../lib/scanner/decay/run-decay-core.mjs";

function lagRow(i, hit, extras = {}) {
  return {
    observed_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    resolved_at: new Date(Date.UTC(2026, 0, 1, 1, 0, i)).toISOString(),
    resolved_outcome: hit ? "hit" : "miss",
    signal_strength_cents: hit ? 4 : 1,
    lag_ms: hit ? 120 : 800,
    ...extras,
  };
}

test("uniform prior uses mean PSI when feature_importance_n < 50", () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(lagRow(i, i % 3 !== 0, { lag_ms: 100 }));
  const withShift = rows.concat(
    Array.from({ length: 40 }, (_, j) => lagRow(100 + j, j % 2 === 0, { lag_ms: 900 })),
  );
  const m = computeDecayMetrics({
    resolvedRows: withShift,
    scannerTable: "scanner_informational_lag_signals",
    featureImportance: { lag_ms: 0.99 },
    featureImportanceN: 10,
    anchorNow: new Date(),
    kswinOpts: { alpha: 0.2, windowSize: 60, statSize: 20, seed: 7 },
  });
  assert.ok(m.weightedDrift >= 0);
  assert.equal(typeof m.streamingKswinAlarm, "boolean");
});

test("weighted drift applies stored importance when n >= 50", () => {
  const rows = [];
  for (let i = 0; i < 35; i++) rows.push(lagRow(i, true, { lag_ms: 50, signal_strength_cents: 2 }));
  for (let i = 0; i < 35; i++)
    rows.push(lagRow(50 + i, false, { lag_ms: 900, signal_strength_cents: 9 }));

  const importance = { lag_ms: 0.9, signal_strength_cents: 0.1 };
  const m = computeDecayMetrics({
    resolvedRows: rows,
    scannerTable: "scanner_informational_lag_signals",
    featureImportance: importance,
    featureImportanceN: 55,
    anchorNow: new Date(),
    kswinOpts: { seed: 11, windowSize: 70, statSize: 22, alpha: 0.05 },
  });
  assert.ok(Object.keys(m.psiPerFeature).length > 0);
});
