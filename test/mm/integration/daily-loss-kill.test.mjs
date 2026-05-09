import test from "node:test";
import assert from "node:assert/strict";
import { KillSwitchOnDailyLoss } from "../../../lib/mm/risk/protections/KillSwitchOnDailyLoss.mjs";

test("daily loss breach fires halt + kill event hook", async () => {
  /** @type {object[]} */
  const rows = [];
  const ks = new KillSwitchOnDailyLoss({
    insertKillEvent: async (row) => {
      rows.push(row);
    },
  });
  const a = ks.globalStop({ portfolioDailyPnLCents: -600, dailyLossLimitCents: 500 });
  assert.equal(a?.stop, "halt");
  assert.equal(rows.length >= 1, true);
});
