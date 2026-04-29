/**
 * @import test from 'node:test';
 * @import assert from 'node:assert/strict';
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  yesNetDeltaContracts,
  rollupPositionAccounting,
} from "../../lib/mm/position-store.mjs";

test("yesNetDelta matches MM side semantics", () => {
  assert.equal(yesNetDeltaContracts("yes_buy", 10), 10);
  assert.equal(yesNetDeltaContracts("yes_sell", 10), -10);
  assert.equal(yesNetDeltaContracts("no_buy", 5), -5);
  assert.equal(yesNetDeltaContracts("no_sell", 5), 5);
});

test("rollup: open long then add", () => {
  let p = rollupPositionAccounting({}, 8, 40);
  assert.equal(p.net_contracts, 8);
  assert.equal(p.avg_cost_cents, 40);
  p = rollupPositionAccounting(p, 2, 60);
  assert.equal(p.net_contracts, 10);
  assert.equal(p.avg_cost_cents, 44);
});

test("rollup: partial close long", () => {
  const after = rollupPositionAccounting({ net_contracts: 10, avg_cost_cents: 44 }, -3, 50);
  assert.equal(after.net_contracts, 7);
  assert.equal(after.avg_cost_cents, 44);
  assert.equal(after.realized_pnl_cents, 18);
});

test("rollup: flat long", () => {
  const after = rollupPositionAccounting({ net_contracts: 7, avg_cost_cents: 44 }, -7, 50);
  assert.equal(after.net_contracts, 0);
  assert.equal(after.avg_cost_cents, null);
  assert.equal(after.realized_pnl_cents, 42);
});

test("rollup: flip long to short", () => {
  const after = rollupPositionAccounting({ net_contracts: 5, avg_cost_cents: 60 }, -12, 40);
  assert.equal(after.net_contracts, -7);
  assert.equal(after.avg_cost_cents, 40);
  assert.ok(after.realized_pnl_cents < 0);
});
