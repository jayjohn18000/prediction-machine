import test from "node:test";
import assert from "node:assert/strict";
import { computeFeatureImportanceFit } from "../../../lib/scanner/decay/run-decay-core.mjs";

test("logistic fit assigns larger weight to predictive column", () => {
  const keys = ["x_noise", "x_signal"];
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const noise = Math.random();
    const sig = i % 2 === 0 ? 2 : -2;
    const hit = sig > 0 ? "hit" : "miss";
    rows.push({
      resolved_outcome: hit,
      x_noise: noise,
      x_signal: sig + noise * 0.01,
    });
  }
  const { importance } = computeFeatureImportanceFit(rows, keys);
  assert.ok(importance.x_signal >= importance.x_noise * 0.5);
});
