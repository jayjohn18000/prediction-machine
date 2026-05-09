import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateVpinPull,
  markVpinPullUntil,
  isVpinPullActive,
} from "../../../lib/mm/gates/vpin-context.mjs";

test("VPIN spike pulls quotes for 60s window", () => {
  const trades = [];
  for (let i = 0; i < 40; i++) trades.push({ side: "buy", size: 50 });
  for (let i = 0; i < 40; i++) trades.push({ side: "sell", size: 2 });
  const ev = evaluateVpinPull(trades, 0.7, 30, 5);
  assert.equal(ev.pull, true);

  const until = {};
  markVpinPullUntil(until, "KXTEST", 1_000_000);
  assert.ok(isVpinPullActive(until, "KXTEST", 1_000_000 + 30_000));
  assert.ok(!isVpinPullActive(until, "KXTEST", 1_000_000 + 70_000));
});
