import test from "node:test";
import assert from "node:assert/strict";
import { computePsi } from "../../../lib/scanner/decay/psi.mjs";

test("PSI increases when reference and current distributions diverge", () => {
  const ref = Array.from({ length: 80 }, () => Math.random() * 1 + 10);
  const cur = Array.from({ length: 80 }, () => Math.random() * 5 + 15);
  const sameRef = Array.from({ length: 80 }, () => 12 + Math.random() * 0.02);
  const sameCur = Array.from({ length: 80 }, () => 12 + Math.random() * 0.02);
  const shiftPsi = computePsi(ref, cur, 10);
  const stablePsi = computePsi(sameRef, sameCur, 10);
  assert.ok(shiftPsi !== null && stablePsi !== null);
  assert.ok(shiftPsi > stablePsi + 0.05);
});
