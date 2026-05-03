import test from "node:test";
import assert from "node:assert/strict";
import {
  recordMmPlacementFailure,
  recordMmPlacementSuccess,
  isTickerSkippedForPlacementBurst,
  MM_REJECT_BURST_THRESHOLD,
  MM_REJECT_BURST_WINDOW_MS,
  ensureMmRejectState,
  reconcileMmRejectBurstSkips,
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

test("reconcile removes skip once burst timestamps fall outside the window", () => {
  const t = "KXTEST-RECOVER";
  const now = 1700000000000;
  const oldTs = MM_REJECT_BURST_WINDOW_MS + 5_000;
  const bursts = [];
  for (let i = 0; i <= MM_REJECT_BURST_THRESHOLD; i += 1) bursts.push(now - oldTs);

  /** @type {Record<string, unknown>} */
  const st = {};
  ensureMmRejectState(st);
  /** @type {Record<string, number[]>} */ (/** @type {unknown} */ (st.rejectBurstByTicker))[t] = bursts;
  /** @type {Set<string>} */ (st.skippedPlacementTickers).add(t);
  assert.equal(isTickerSkippedForPlacementBurst(st, t), true);

  reconcileMmRejectBurstSkips(st, now);

  assert.equal(isTickerSkippedForPlacementBurst(st, t), false);
});

test("reconcile keeps skip while failures remain dense inside the window", () => {
  const t = "KXTEST-HOT";
  const now = 1700000000000;
  const bursts = [];
  for (let i = 0; i <= MM_REJECT_BURST_THRESHOLD; i += 1) bursts.push(now - 1000 * (i + 1));

  /** @type {Record<string, unknown>} */
  const st = {};
  ensureMmRejectState(st);
  /** @type {Record<string, number[]>} */ (/** @type {unknown} */ (st.rejectBurstByTicker))[t] = bursts;
  /** @type {Set<string>} */ (st.skippedPlacementTickers).add(t);

  reconcileMmRejectBurstSkips(st, now);

  assert.equal(isTickerSkippedForPlacementBurst(st, t), true);
});
