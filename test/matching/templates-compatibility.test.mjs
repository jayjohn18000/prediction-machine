import test from "node:test";
import assert from "node:assert/strict";
import { areTemplatesCompatible } from "../../lib/matching/templates/compatibility-rules.mjs";

test("btc daily range + direction with same date", () => {
  const r = areTemplatesCompatible(
    "btc-daily-range",
    { asset: "btc", date: "2026-04-14" },
    "btc-daily-direction",
    { asset: "btc", date: "2026-04-14" },
  );
  assert.equal(r.compatible, true);
});

test("fed decision cross-direction same meeting", () => {
  const r = areTemplatesCompatible(
    "fed-rate-decision",
    { meeting_date: "2026-03-19" },
    "fed-rate-direction",
    { meeting_date: "2026-03-19" },
  );
  assert.equal(r.compatible, true);
});

test("interval isolated", () => {
  const r = areTemplatesCompatible(
    "btc-interval",
    { asset: "btc" },
    "btc-daily-range",
    { asset: "btc", date: "2026-04-14" },
  );
  assert.equal(r.compatible, false);
});
