import test from "node:test";
import assert from "node:assert/strict";
import {
  recordMmPlacementFailure,
  recordMmPlacementSuccess,
  isTickerSkippedForPlacementBurst,
  MM_REJECT_BURST_THRESHOLD,
  ensureMmRejectState,
} from "../../lib/mm/reject-burst-guard.mjs";

test("reject burst skips ticker after more than threshold failures in window", () => {
  const st = {};
  const t = "KXTEST-1";
  for (let i = 0; i < MM_REJECT_BURST_THRESHOLD; i += 1) {
    recordMmPlacementFailure(st, t);
    assert.equal(isTickerSkippedForPlacementBurst(st, t), false);
  }
  recordMmPlacementFailure(st, t);
  assert.equal(isTickerSkippedForPlacementBurst(st, t), true);
});

test("success clears skip and burst history", () => {
  const st = {};
  const t = "KXTEST-2";
  for (let i = 0; i <= MM_REJECT_BURST_THRESHOLD; i += 1) recordMmPlacementFailure(st, t);
  assert.equal(isTickerSkippedForPlacementBurst(st, t), true);
  recordMmPlacementSuccess(st, t);
  assert.equal(isTickerSkippedForPlacementBurst(st, t), false);
  assert.equal(ensureMmRejectState(st).rejectBurstByTicker[t], undefined);
});
