import test from "node:test";
import assert from "node:assert/strict";
import { MaxDrawdownLadder } from "../../../lib/mm/risk/protections/MaxDrawdownLadder.mjs";

test("-3% drawdown → halt from MaxDrawdownLadder", () => {
  const p = new MaxDrawdownLadder({ maxDrawdownPctGlobal: 0.03 });
  const r = p.globalStop({
    peakEquityCents: 10_000,
    equityCents: 9670,
    maxDrawdownPctGlobal: 0.03,
  });
  assert.deepEqual(r, { stop: "halt", reason: "drawdown_3pct" });
});
