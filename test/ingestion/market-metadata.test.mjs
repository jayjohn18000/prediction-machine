import test from "node:test";
import assert from "node:assert/strict";
import {
  inferElectionPhase,
  inferSubjectType,
} from "../../lib/ingestion/services/market-metadata.mjs";

// inferElectionPhase

test("inferElectionPhase — defaults to general", () => {
  assert.equal(inferElectionPhase("PRES-2028", "Who will win?"), "general");
});

test("inferElectionPhase — detects primary via title", () => {
  assert.equal(inferElectionPhase("PRES-2028", "Who wins the primary?"), "primary");
});

test("inferElectionPhase — detects primary via ticker -PRI- segment", () => {
  assert.equal(inferElectionPhase("PRES-PRI-2028", "Some title"), "primary");
});

test("inferElectionPhase — detects runoff", () => {
  assert.equal(inferElectionPhase("SENATE-2026", "Senate runoff winner"), "runoff");
});

test("inferElectionPhase — detects special", () => {
  assert.equal(inferElectionPhase("SEN-2026", "Special election winner"), "special");
});

test("inferElectionPhase — handles null/empty inputs", () => {
  assert.equal(inferElectionPhase(null, null), "general");
  assert.equal(inferElectionPhase("", ""), "general");
});

// inferSubjectType

test("inferSubjectType — defaults to candidate", () => {
  assert.equal(inferSubjectType("PRES-2028", "Who wins?"), "candidate");
});

test("inferSubjectType — detects party via GOVPARTY ticker prefix", () => {
  assert.equal(inferSubjectType("GOVPARTY-2026", "Which party wins?"), "party");
});

test("inferSubjectType — detects party via SENATE-*-REP ticker", () => {
  assert.equal(inferSubjectType("SENATE-OH-REP", "Ohio Senate"), "party");
});

test("inferSubjectType — detects party via SENATE-*-DEM ticker", () => {
  assert.equal(inferSubjectType("SENATE-TX-DEM", "Texas Senate"), "party");
});

test("inferSubjectType — detects appointment via title", () => {
  assert.equal(inferSubjectType("FED-CHAIR", "Who will Trump nominate as Fed Chair?"), "appointment");
  assert.equal(inferSubjectType("FED-CHAIR", "Fed appointment decision"), "appointment");
  assert.equal(inferSubjectType("FED-CHAIR", "Who will be appointed?"), "appointment");
});

test("inferSubjectType — detects policy via title keywords", () => {
  assert.equal(inferSubjectType("FED-RATE", "Fed rate decision March 2026"), "policy");
  assert.equal(inferSubjectType("POLICY-01", "Will the bill pass?"), "policy");
  assert.equal(inferSubjectType("POLICY-01", "Will the act pass?"), "policy");
});

test("inferSubjectType — handles null/empty inputs", () => {
  assert.equal(inferSubjectType(null, null), "candidate");
  assert.equal(inferSubjectType("", ""), "candidate");
});
