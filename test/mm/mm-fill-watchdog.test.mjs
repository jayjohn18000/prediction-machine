import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMmWatchdogAlerts } from "../../lib/mm/mm-fill-watchdog.mjs";

test("fill_rate_floor when 4h activity high and fills sparse", () => {
  const rows = [
    {
      market_id: 1,
      orders_4h: 2000,
      fills_4h: 0,
      orders_1h: 100,
      rejects_1h: 0,
    },
  ];
  const a = evaluateMmWatchdogAlerts(rows, { "1": "KX-1" });
  assert.equal(a.some((x) => x.reason === "fill_rate_floor"), true);
});

test("reject_storm when majority rejected in 1h", () => {
  const rows = [
    {
      market_id: 2,
      orders_4h: 10,
      fills_4h: 2,
      orders_1h: 100,
      rejects_1h: 60,
    },
  ];
  const a = evaluateMmWatchdogAlerts(rows, { "2": "KX-2" });
  assert.equal(a.some((x) => x.reason === "reject_storm"), true);
});

test("quiet market skipped for fill floor", () => {
  const rows = [
    { market_id: 3, orders_4h: 10, fills_4h: 0, orders_1h: 2, rejects_1h: 0 },
  ];
  assert.equal(evaluateMmWatchdogAlerts(rows, { "3": "KX-3" }).length, 0);
});
