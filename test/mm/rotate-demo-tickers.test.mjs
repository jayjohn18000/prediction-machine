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

/** Selection tests omit prod Kalshi comparison (fake tickers) for speed and determinism. */
const selOpts = { skipProdCrossCheck: true };

const m = (overrides) => ({
  ticker: "KXTEST-FAR",
  event_ticker: "KXTESTEV-FAR",
  yes_bid_dollars: "0.20",
  yes_ask_dollars: "0.30",
  volume_24h_fp: "10",
  close_time: FAR_CLOSE,
  ...overrides,
});

test("selectMarketsForRotation picks top by volume when category/spread/urgency tied", async () => {
  const { selections: out } = await selectMarketsForRotation(
    [
      m({ ticker: "A", event_ticker: "EV-A", volume_24h_fp: "100" }),
      m({ ticker: "B", event_ticker: "EV-B", volume_24h_fp: "50" }),
      m({ ticker: "C", event_ticker: "EV-C", volume_24h_fp: "5" }),
    ],
    { nowMs: NOW_MS, target: 2, minCloseHours: 24, ...selOpts },
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].ticker, "A");
  assert.equal(out[1].ticker, "B");
});

test("selectMarketsForRotation rejects near-close markets", async () => {
  const { selections: out } = await selectMarketsForRotation(
    [
      m({ ticker: "A", close_time: NEAR_CLOSE }),
      m({ ticker: "B", close_time: PAST_CLOSE }),
      m({ ticker: "C", close_time: FAR_CLOSE }),
    ],
    { nowMs: NOW_MS, target: 8, minCloseHours: 24, ...selOpts },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].ticker, "C");
});

test("selectMarketsForRotation rejects no-bid / no-ask / crossed / wide-only books", async () => {
  const { selections: out } = await selectMarketsForRotation(
    [
      m({ ticker: "NO_BID", yes_bid_dollars: "0" }),
      m({ ticker: "NO_ASK", yes_ask_dollars: "0" }),
      m({ ticker: "CROSSED", yes_bid_dollars: "0.50", yes_ask_dollars: "0.40" }),
      m({ ticker: "FULL_NO_ASK", yes_bid_dollars: "0.10", yes_ask_dollars: "1.0000" }),
      m({ ticker: "OK", yes_bid_dollars: "0.10", yes_ask_dollars: "0.20" }),
    ],
    { nowMs: NOW_MS, target: 8, minCloseHours: 24, ...selOpts },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].ticker, "OK");
});

test("selectMarketsForRotation skips multi-event KXMVE tickers", async () => {
  const { selections: out } = await selectMarketsForRotation(
    [m({ ticker: "KXMVECROSSCATEGORY-XXX" }), m({ ticker: "KXNORMAL-A" })],
    { nowMs: NOW_MS, target: 8, minCloseHours: 24, ...selOpts },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].ticker, "KXNORMAL-A");
});

test("selectMarketsForRotation excludes -B<digit> strike markets (Kalshi DEMO post-only rejects)", async () => {
  const { selections: out } = await selectMarketsForRotation(
    [
      m({ ticker: "KXHIGHTLV-26MAY01-B89.5" }),
      m({ ticker: "KXHIGHMIA-26MAY01-B90.5" }),
      m({ ticker: "KXHIGHTPHX-26MAY01-B91.5" }),
      m({ ticker: "KXHIGHTNOLA-26MAY01-T77" }),
      m({ ticker: "KXHIGHPHIL-26MAY01-T63" }),
    ],
    { nowMs: NOW_MS, target: 8, minCloseHours: 24, ...selOpts },
  );
  const tickers = out.map((s) => s.ticker);
  assert.deepEqual(tickers.sort(), ["KXHIGHPHIL-26MAY01-T63", "KXHIGHTNOLA-26MAY01-T77"]);
});

test("selectMarketsForRotation prefers nearer-term sports when volume tied (urgency)", async () => {
  const { selections: out } = await selectMarketsForRotation(
    [
      m({
        ticker: "KXNBA-MID",
        event_ticker: "E-MID",
        close_time: MID_CLOSE,
        volume_24h_fp: "100",
      }),
      m({
        ticker: "KXNBA-FAR",
        event_ticker: "E-FAR",
        close_time: FAR_CLOSE,
        volume_24h_fp: "100",
      }),
    ],
    { nowMs: NOW_MS, target: 8, minCloseHours: 24, ...selOpts },
  );
  assert.equal(out[0].ticker, "KXNBA-MID");
});

test("selectMarketsForRotation respects target cap", async () => {
  const leagues = ["KXNBA", "KXMLB", "KXNHL", "KXNFL", "KXUFC", "KXPGA", "KXATP", "KXIPL"];
  const { selections: out } = await selectMarketsForRotation(
    Array.from({ length: 20 }, (_, i) =>
      m({
        ticker: `${leagues[i % 8]}-R${i}`,
        event_ticker: `EV-${i}`,
        volume_24h_fp: String(20 - i),
      }),
    ),
    { nowMs: NOW_MS, target: 8, minCloseHours: 24, ...selOpts },
  );
  assert.equal(out.length, 8);
  assert.equal(out[0].ticker, "KXNBA-R0"); // highest volume among first batch
});

test("selectMarketsForRotation applies max 3 per event_ticker", async () => {
  const markets = Array.from({ length: 10 }, (_, i) =>
    m({
      ticker: `KXNBA-X${i}`,
      event_ticker: "SAME-EVENT",
      volume_24h_fp: String(1000 - i),
    }),
  );
  const { selections } = await selectMarketsForRotation(markets, {
    nowMs: NOW_MS,
    target: 8,
    minCloseHours: 24,
    ...selOpts,
  });
  assert.equal(selections.length, 3);
});

test("selectMarketsForRotation diversification 3 events × 5 → 9 selections", async () => {
  const markets = [];
  const leagues = ["KXNBA", "KXMLB", "KXNHL"];
  for (let e = 0; e < 3; e++) {
    const league = leagues[e];
    for (let i = 0; i < 5; i++) {
      markets.push(
        m({
          ticker: `${league}-E${e}-M${i}`,
          event_ticker: `EVENT-${e}`,
          volume_24h_fp: String(500 - e * 10 - i),
        }),
      );
    }
  }
  const { selections } = await selectMarketsForRotation(markets, {
    nowMs: NOW_MS,
    target: 20,
    minCloseHours: 24,
    ...selOpts,
  });
  assert.equal(selections.length, 9);
});

test("selectMarketsForRotation diversification max 5 per sport then fills target 10", async () => {
  const leagues = ["KXNBA", "KXMLB", "KXNHL", "KXNFL"];
  const markets = [];
  for (let s = 0; s < 4; s++) {
    const league = leagues[s];
    for (let i = 0; i < 5; i++) {
      markets.push(
        m({
          ticker: `${league}-E${s}M${i}`,
          event_ticker: `EV-${s}-${i}`,
          volume_24h_fp: String(2000 - s * 100 - i),
        }),
      );
    }
  }
  const { selections } = await selectMarketsForRotation(markets, {
    nowMs: NOW_MS,
    target: 10,
    minCloseHours: 24,
    ...selOpts,
  });
  assert.equal(selections.length, 10);
});

test("selectMarketsForRotation excludes blocklist tickers", async () => {
  const { selections, rejected } = await selectMarketsForRotation(
    [
      m({ ticker: "KEEP", event_ticker: "E1", volume_24h_fp: "1" }),
      m({ ticker: "BLOCKED", event_ticker: "E2", volume_24h_fp: "9999" }),
    ],
    {
      nowMs: NOW_MS,
      target: 8,
      minCloseHours: 24,
      blockedTickers: new Set(["BLOCKED"]),
      ...selOpts,
    },
  );
  assert.equal(selections.length, 1);
  assert.equal(selections[0].ticker, "KEEP");
  assert.ok(rejected.some((r) => r.ticker === "BLOCKED" && r.reason === "blocklist"));
});
