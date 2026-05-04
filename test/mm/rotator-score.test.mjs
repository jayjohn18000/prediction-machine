/**
 * Rotator scoring: volume × category × urgency × spread (ADR-013 selection).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeRotatorScoreFields,
  categoryMultiplier,
} from "../../scripts/mm/rotate-demo-tickers.mjs";

const NOW_MS = Date.parse("2026-04-30T14:00:00Z");
const CLOSE_4H = "2026-04-30T18:00:00Z";
const CLOSE_30D = "2026-05-30T14:00:00Z";

test("sports 100k vol, 4h to close, 5c spread → 150000", () => {
  const m = {
    ticker: "KXNBA-TEST",
    event_ticker: "KXNBAGAME-1",
    close_time: CLOSE_4H,
    volume_24h_fp: "100000",
    yes_bid_dollars: "0.45",
    yes_ask_dollars: "0.50",
  };
  const f = computeRotatorScoreFields(m, NOW_MS);
  assert.equal(f.volume, 100000);
  assert.equal(f.categoryKey, "sports");
  assert.equal(f.catM, 1.0);
  assert.equal(f.urgM, 1.5);
  assert.equal(f.spreadCents, 5);
  assert.equal(f.sprM, 1.0);
  assert.equal(f.score, 150000);
});

test("finance ticker same params → score 0 (category multiplier)", () => {
  const m = {
    ticker: "KXWTIMAX-26-TST",
    event_ticker: "KXWTI-EV",
    close_time: CLOSE_4H,
    volume_24h_fp: "100000",
    yes_bid_dollars: "0.45",
    yes_ask_dollars: "0.50",
  };
  const f = computeRotatorScoreFields(m, NOW_MS);
  assert.equal(f.categoryKey, "finance");
  assert.equal(categoryMultiplier("finance"), 0);
  assert.equal(f.score, 0);
});

test("long-dated sports 1M vol, ~30d, tight spread → 300000", () => {
  const m = {
    ticker: "KXNBA-LONG",
    event_ticker: "KXNBAGAME-L",
    close_time: CLOSE_30D,
    volume_24h_fp: "1000000",
    yes_bid_dollars: "0.45",
    yes_ask_dollars: "0.50",
  };
  const f = computeRotatorScoreFields(m, NOW_MS);
  assert.equal(f.urgM, 0.3);
  assert.equal(f.score, 300000);
});

test("1c spread yields sprM 0 (safety net vs locked book)", () => {
  const m = {
    ticker: "KXNBA-LOCK",
    event_ticker: "KXNBAGAME-2",
    close_time: CLOSE_4H,
    volume_24h_fp: "50",
    yes_bid_dollars: "0.49",
    yes_ask_dollars: "0.50",
  };
  const f = computeRotatorScoreFields(m, NOW_MS);
  assert.equal(f.spreadCents, 1);
  assert.equal(f.sprM, 0);
  assert.equal(f.score, 0);
});
