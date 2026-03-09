import test from "node:test";
import assert from "node:assert/strict";
import { parseSince } from "../../src/utils/time.mjs";

test("parseSince supports relative hours", () => {
  const now = Date.now();
  const d = parseSince("24h");
  assert.ok(d instanceof Date);
  const diff = now - d.getTime();
  assert.ok(diff > 23 * 3600_000 && diff < 25 * 3600_000);
});

test("parseSince supports relative days", () => {
  const now = Date.now();
  const d = parseSince("7d");
  assert.ok(d instanceof Date);
  const diff = now - d.getTime();
  assert.ok(diff > 6 * 24 * 3600_000 && diff < 8 * 24 * 3600_000);
});

test("parseSince supports ISO timestamps", () => {
  const d = parseSince("2026-03-08T10:00:00.000Z");
  assert.ok(d instanceof Date);
  assert.equal(d.toISOString(), "2026-03-08T10:00:00.000Z");
});

test("parseSince returns null for invalid input", () => {
  assert.equal(parseSince(undefined), null);
  assert.equal(parseSince(""), null);
  assert.equal(parseSince("nonsense"), null);
});
