import test from "node:test";
import assert from "node:assert/strict";
import { syncMmOrderFillStateFromFills } from "../../lib/mm/order-store.mjs";

test("syncMmOrderFillStateFromFills sets filled when cumulative fills reach order size", async () => {
  /** @type {unknown[] | null} */
  let updateParams = null;
  const client = {
    /** @param {string} q */
    async query(q, params = []) {
      if (/SELECT size_contracts/.test(q)) {
        return { rows: [{ sz: 10 }] };
      }
      if (/FROM pmci.mm_fills/.test(q)) {
        return { rows: [{ total_sz: 10, last_at: new Date("2026-05-01T12:00:00Z"), vwap_px: 55 }] };
      }
      if (/UPDATE pmci.mm_orders/.test(q)) {
        updateParams = params;
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  await syncMmOrderFillStateFromFills(/** @type {any} */ (client), 100);
  assert.ok(updateParams);
  assert.equal(updateParams[1], "filled");
});

test("syncMmOrderFillStateFromFills sets partial when below order size", async () => {
  /** @type {unknown[] | null} */
  let updateParams = null;
  const client = {
    /** @param {string} q */
    async query(q, params = []) {
      if (/SELECT size_contracts/.test(q)) return { rows: [{ sz: 10 }] };
      if (/FROM pmci.mm_fills/.test(q)) {
        return { rows: [{ total_sz: 3, last_at: new Date("2026-05-01T12:00:00Z"), vwap_px: 50 }] };
      }
      if (/UPDATE pmci.mm_orders/.test(q)) {
        updateParams = params;
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  await syncMmOrderFillStateFromFills(/** @type {any} */ (client), 7);
  assert.ok(updateParams);
  assert.equal(updateParams[1], "partial");
});
