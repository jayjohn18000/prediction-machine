import test from "node:test";
import assert from "node:assert/strict";
import { computeHalfSpreadCents } from "../../../lib/mm/fair-value/avellaneda-stoikov.mjs";

test("rodlaf bug 2: half-spread positive for random valid states", () => {
  for (let i = 0; i < 200; i++) {
    const gamma = 0.05 + Math.random() * 0.25;
    const sigma = 0.06 + Math.random() * 0.08;
    const kappa = 0.5 + Math.random() * 2;
    const tau = 0.05 + Math.random() * 0.4;
    const h = computeHalfSpreadCents({ gamma, sigma, kappa, tau });
    assert.ok(Number.isFinite(h) && h > 0, `half=${h} gamma=${gamma} sigma=${sigma} kappa=${kappa} tau=${tau}`);
  }
});
