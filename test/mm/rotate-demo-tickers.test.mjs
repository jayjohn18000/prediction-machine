/**
 * Unit tests for the rotator's pure selection logic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { selectMarketsForRotation } from "../../scripts/mm/rotate-demo-tickers.mjs";

const NOW_MS = Date.parse("2026-04-30T14:00:00Z");
const FAR_CLOSE = "2026-05-15T17:00:00Z"; // 15 days out — passes minCloseHours
const MID_CLOSE = "2026-05-02T17:00:00Z"; // ~2 days out — passes
const NEAR_CLOSE = "2026-04-30T18:00:00Z"; // ~4h out — fails minCloseHours=24
const PAST_CLOSE = "2026-04-29T18:00:00Z"; // already past — fails

const m = (overrides) => ({
  ticker: "KXTEST-FAR",
  yes_bid_dollars: "0.20",
  yes_ask_dollars: "0.30",
  volume_24h_fp: "10",
  close_time: FAR_CLOSE,
  ...overrides,
});

test("selectMarketsForRotation picks top by volume + close-time score", () => {
  const out = selectMarketsForRotation(
    [
      m({ ticker: "A", volume_24h_fp: "100" }),
      m({ ticker: "B", volume_24h_fp: "50" }),
      m({ ticker: "C", volume_24h_fp: "5" }),
    ],
    { nowMs: NOW_MS, target: 2, minCloseHours: 24 },
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].ticker, "A");
  assert.equal(out[1].ticker, "B");
});

test("selectMarketsForRotation rejects near-close markets", () => {
  const out = selectMarketsForRotation(
    [
      m({ ticker: "A", close_time: NEAR_CLOSE }),
      m({ ticker: "B", close_time: PAST_CLOSE }),
      m({ ticker: "C", close_time: FAR_CLOSE }),
    ],
    { nowMs: NOW_MS, target: 8, minCloseHours: 24 },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].ticker, "C");
});

test("selectMarketsForRotation rejects no-bid / no-ask / crossed / wide-only books", () => {
  const out = selectMarketsForRotation(
    [
      m({ ticker: "NO_BID", yes_bid_dollars: "0" }),
      m({ ticker: "NO_ASK", yes_ask_dollars: "0" }),
      m({ ticker: "CROSSED", yes_bid_dollars: "0.50", yes_ask_dollars: "0.40" }),
      m({ ticker: "FULL_NO_ASK", yes_bid_dollars: "0.10", yes_ask_dollars: "1.0000" }),
      m({ ticker: "OK", yes_bid_dollars: "0.10", yes_ask_dollars: "0.20" }),
    ],
    { nowMs: NOW_MS, target: 8, minCloseHours: 24 },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].ticker, "OK");
});

test("selectMarketsForRotation skips multi-event KXMVE tickers", () => {
  const out = selectMarketsForRotation(
    [m({ ticker: "KXMVECROSSCATEGORY-XXX" }), m({ ticker: "KXNORMAL-A" })],
    { nowMs: NOW_MS, target: 8, minCloseHours: 24 },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].ticker, "KXNORMAL-A");
});

test("selectMarketsForRotation prefers longer close time when volume tied", () => {
  const out = selectMarketsForRotation(
    [
      m({ ticker: "MID", close_time: MID_CLOSE, volume_24h_fp: "0" }),
      m({ ticker: "FAR", close_time: FAR_CLOSE, volume_24h_fp: "0" }),
    ],
    { nowMs: NOW_MS, target: 8, minCloseHours: 24 },
  );
  assert.equal(out[0].ticker, "FAR");
});

test("selectMarketsForRotation respects target cap", () => {
  const out = selectMarketsForRotation(
    Array.from({ length: 20 }, (_, i) =>
      m({ ticker: `T${i}`, volume_24h_fp: String(20 - i) }),
    ),
    { nowMs: NOW_MS, target: 8, minCloseHours: 24 },
  );
  assert.equal(out.length, 8);
  assert.equal(out[0].ticker, "T0"); // highest volume
});
