import test from "node:test";
import assert from "node:assert/strict";
import { computeRotatorScoreFields } from "../../../scripts/mm/rotate-demo-tickers.mjs";

test("rodlaf bug 4: narrow-spread market scores higher ceteris paribus", () => {
  const nowMs = Date.parse("2026-05-08T16:00:00.000Z");
  const close = "2026-05-09T16:00:00.000Z";
  const base = {
    ticker: "KXMLBGAME-TEST1",
    event_ticker: "KXMLBEV1",
    volume_24h_fp: "5000",
    close_time: close,
  };
  const narrow = {
    ...base,
    ticker: "KXMLBGAME-NARROW",
    yes_bid_dollars: "0.45",
    yes_ask_dollars: "0.48",
  };
  const wide = {
    ...base,
    ticker: "KXMLBGAME-WIDE",
    yes_bid_dollars: "0.40",
    yes_ask_dollars: "0.52",
  };
  const sn = computeRotatorScoreFields(narrow, nowMs);
  const sw = computeRotatorScoreFields(wide, nowMs);
  assert.ok(sn.score > sw.score, `narrow ${sn.score} should beat wide ${sw.score}`);
});
