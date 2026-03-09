import test from "node:test";
import assert from "node:assert/strict";
import { resolveProviderIdByCode } from "../../src/repositories/providers-repo.mjs";

test("resolveProviderIdByCode returns provider id when found", async () => {
  const q = async () => ({ rows: [{ id: 123 }], rowCount: 1 });
  const id = await resolveProviderIdByCode(q, "kalshi");
  assert.equal(id, 123);
});

test("resolveProviderIdByCode returns null when provider is unknown", async () => {
  const q = async () => ({ rows: [], rowCount: 0 });
  const id = await resolveProviderIdByCode(q, "unknown");
  assert.equal(id, null);
});
