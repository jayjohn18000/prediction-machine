/**
 * Synthetic pair-failure alert (Pre-W6) — pure aggregates + optional DB-backed check.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

import { loadEnv } from "../../src/platform/env.mjs";

import {
  PAIR_FAILURE_ALERT_THRESHOLD,
  buildByProviderDrilldown,
  buildTrueSuccessRateBlockFromAggregate,
} from "../../src/services/pair-failure-alert.mjs";
import { getObserverHealth } from "../../src/services/observer-health.mjs";

loadEnv();

test("aggregate failure triggers alert above threshold", () => {
  const block = buildTrueSuccessRateBlockFromAggregate({
    pairs_attempted: 91,
    pairs_succeeded: 74,
  });
  assert.equal(block.pairs_failed, 17);
  assert.ok(block.failure_rate != null && block.failure_rate > PAIR_FAILURE_ALERT_THRESHOLD);
  assert.equal(block.alert, true);
  assert.equal(block.alert_reason, "polymarket_pair_failure_rate_exceeded");
});

test("by_provider allocates failed pairs toward polymarket when poly errors dominate weights", () => {
  const b = buildByProviderDrilldown({
    pairs_attempted: 91,
    pairs_succeeded: 74,
    sum_kalshi_fetch_errors: 0,
    sum_polymarket_fetch_errors: 100,
    sum_spread_insert_errors: 0,
  });
  assert.ok(Number(b.polymarket.failure_rate) > Number(b.kalshi.failure_rate));
});

test("getObserverHealth true_success_rate.alert on synthetic Σ gap (DATABASE_URL)", async (t) => {
  if (!process.env.DATABASE_URL?.trim()) {
    t.skip("DATABASE_URL unset");
    return;
  }
  const cycleAt = new Date().toISOString();
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO pmci.observer_heartbeats (
        cycle_at, pairs_attempted, pairs_succeeded, pairs_configured,
        kalshi_fetch_errors, polymarket_fetch_errors,
        spread_insert_errors, pmci_ingestion_errors, json_parse_errors
      ) VALUES ($1::timestamptz, $2, $3, $4, 0, $5, 0, 0, 0)`,
      [cycleAt, 1000, 200, 1000, 500],
    );
    const out = await getObserverHealth({ query: (text, vals) => c.query(text, vals) }, {});
    await c.query("ROLLBACK");
    const tsr = out.true_success_rate;
    assert.equal(tsr.alert, true);
    assert.ok(Number(tsr.failure_rate) > 0.1);
  } finally {
    await c.end().catch(() => {});
  }
});
