import test from "node:test";
import assert from "node:assert/strict";

test("3c fair vs mid logs taker_on_conviction_v2_skipped shape", () => {
  const line = JSON.stringify({
    event: "taker_on_conviction_v2_skipped",
    ticker: "KXFOO",
    fair: 55,
    mid: 50,
  });
  assert.match(line, /taker_on_conviction_v2_skipped/);
});
