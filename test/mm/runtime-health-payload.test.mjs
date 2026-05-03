import test from "node:test";
import assert from "node:assert/strict";
import { buildMmHealthMmResponse } from "../../lib/mm/runtime-health-payload.mjs";

test("ready false when depthTickersStale is non-empty (fixture)", () => {
  const health = {
    ok: true,
    lastOrchestratorError: null,
    lastMainLoopTickAt: new Date().toISOString(),
    depthSubscribedTickers: 2,
  };
  const depthSnap = {
    depthSubscribedConfigured: 2,
    depthSubscribedConnected: 2,
    depthTickersStale: ["KX-ONE"],
  };
  const j = buildMmHealthMmResponse({ health, depthSnap });
  assert.equal(j.ok, true);
  assert.equal(j.ready, false);
  assert.equal(j.severity, "warn");
});

test("ready true when depth connected matches and loop tick fresh", () => {
  const health = {
    ok: true,
    lastOrchestratorError: null,
    lastMainLoopTickAt: new Date().toISOString(),
  };
  const depthSnap = {
    depthSubscribedConfigured: 3,
    depthSubscribedConnected: 3,
    depthTickersStale: [],
  };
  const j = buildMmHealthMmResponse({ health, depthSnap });
  assert.equal(j.ready, true);
  assert.equal(j.severity, "none");
});

test("severity crit when lastOrchestratorError set", () => {
  const health = {
    ok: true,
    lastOrchestratorError: "boom",
    lastMainLoopTickAt: new Date().toISOString(),
  };
  const depthSnap = {
    depthSubscribedConfigured: 1,
    depthSubscribedConnected: 1,
    depthTickersStale: [],
  };
  const j = buildMmHealthMmResponse({ health, depthSnap });
  assert.equal(j.ok, false);
  assert.equal(j.severity, "crit");
});

test("ready false when mmSkippedPlacementTickers non-empty", () => {
  const health = {
    ok: true,
    lastOrchestratorError: null,
    lastMainLoopTickAt: new Date().toISOString(),
    mmSkippedPlacementTickers: ["KX-BROKEN"],
  };
  const depthSnap = {
    depthSubscribedConfigured: 1,
    depthSubscribedConnected: 1,
    depthTickersStale: [],
  };
  const j = buildMmHealthMmResponse({ health, depthSnap });
  assert.equal(j.ready, false);
  assert.equal(j.severity, "warn");
});

test("severity crit when loop tick stale > 60s", () => {
  const health = {
    ok: true,
    lastOrchestratorError: null,
    lastMainLoopTickAt: new Date(Date.now() - 120_000).toISOString(),
  };
  const depthSnap = {
    depthSubscribedConfigured: 1,
    depthSubscribedConnected: 1,
    depthTickersStale: [],
  };
  const j = buildMmHealthMmResponse({ health, depthSnap });
  assert.equal(j.severity, "crit");
  assert.equal(j.ready, false);
});
