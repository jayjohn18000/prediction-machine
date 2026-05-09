import test from "node:test";
import assert from "node:assert/strict";
import { LatencyGate } from "../../../lib/mm/risk/protections/LatencyGate.mjs";

test("latency spike triggers protection (cooldown / pull)", () => {
  const g = new LatencyGate({ maxLagMs: 100 });
  const r = g.globalStop({ kalshiWsLagMs: 500 });
  assert.equal(r?.stop, "cooldown_10min");
  assert.equal(r?.reason, "latency_ws_lag");
});
