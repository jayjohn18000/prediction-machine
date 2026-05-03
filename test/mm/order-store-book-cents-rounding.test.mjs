import test from "node:test";
import assert from "node:assert/strict";
import { roundNullableMmBookCents } from "../../lib/mm/order-store.mjs";

test("roundNullableMmBookCents snaps float drift to integers for Postgres int columns", () => {
  assert.equal(roundNullableMmBookCents(57.99999999999999), 58);
  assert.equal(roundNullableMmBookCents(46.1), 46);
});

test("roundNullableMmBookCents preserves null-ish", () => {
  assert.equal(roundNullableMmBookCents(null), null);
  assert.equal(roundNullableMmBookCents(undefined), null);
});
