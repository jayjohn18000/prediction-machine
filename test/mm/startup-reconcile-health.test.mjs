import test from "node:test";
import assert from "node:assert/strict";
import { stampStartupReconcileHealth } from "../../lib/mm/orchestrator.mjs";

test("stampStartupReconcileHealth sets lastStartupReconcileAt and aliases lastReconcileAt", () => {
  /** @type {Record<string, unknown>} */
  const health = {};
  const before = Date.now();
  stampStartupReconcileHealth(health, { phase: "W4", skipped: false });
  const after = Date.now();
  assert.equal(health.reconcilePhase, "W4");
  assert.equal(health.reconcileSkipped, false);
  assert.ok(typeof health.lastStartupReconcileAt === "string");
  assert.ok(typeof health.lastReconcileAt === "string");
  assert.equal(health.lastStartupReconcileAt, health.lastReconcileAt);
  const t = new Date(String(health.lastStartupReconcileAt)).getTime();
  assert.ok(t >= before && t <= after + 2000);
});
