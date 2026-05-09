import test from "node:test";
import assert from "node:assert/strict";
import { CooldownAfterOneSidedFills } from "../../../lib/mm/risk/protections/CooldownAfterOneSidedFills.mjs";

test("three same-side fills in 5min → cooldown", () => {
  const p = new CooldownAfterOneSidedFills({ consecutive: 3, windowMinutes: 5 });
  const now = Date.now();
  const fills = [
    { side: "yes_buy", observedAtMs: now - 60_000 },
    { side: "yes_buy", observedAtMs: now - 120_000 },
    { side: "yes_buy", observedAtMs: now - 180_000 },
  ];
  const r = p.stopPerMarket(
    {
      nowMs: now,
      recentFillsByTicker: { KX: fills },
      cooldownAfterConsecutiveSameSide: 3,
    },
    "KX",
  );
  assert.deepEqual(r, { stop: "cooldown_10min", reason: "three_same_side_fills" });
});
