import test from "node:test";
import assert from "node:assert/strict";
import { buildKalshiPlacementErrorBlock } from "../../lib/mm/orchestrator.mjs";
import { markMmOrderRejectedKalshi } from "../../lib/mm/order-store.mjs";

test("buildKalshiPlacementErrorBlock maps HTTP error + request_id from body", () => {
  const err = new Error("Kalshi POST /portfolio/orders: HTTP 401");
  /** @type {any} */ (err).status = 401;
  /** @type {any} */ (err).body = { error: "unauthorized", request_id: "rid-xyz" };
  const b = buildKalshiPlacementErrorBlock(err, "cid-1");
  assert.equal(b.status, 401);
  assert.deepEqual(b.body, { error: "unauthorized", request_id: "rid-xyz" });
  assert.equal(b.request_id, "rid-xyz");
  assert.equal(b.client_order_id, "cid-1");
  assert.ok(typeof b.captured_at === "string" && b.captured_at.length > 10);
});

test("markMmOrderRejectedKalshi merges kalshi_error + status rejected", async () => {
  /** @type {unknown[][]} */
  const calls = [];
  const client = {
    /** @param {unknown[]} params */
    async query(q, params = []) {
      calls.push(params);
      return { rows: [] };
    },
  };
  const block = {
    status: 401,
    body: { message: "nope" },
    request_id: "r1",
    client_order_id: "cid",
    captured_at: "2026-05-01T12:00:00.000Z",
  };
  await markMmOrderRejectedKalshi(/** @type {any} */ (client), 42, block);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 42);
  const merged = JSON.parse(String(calls[0][1]));
  assert.deepEqual(merged, { kalshi_error: block });
});
