/**
 * Freshness snapshot query shape + staleness semantics (15-minute snapshot window).
 * Row-level scenarios use mocked `computeLiveFreshnessSnapshot` results: a single INSERT
 * on a shared dev/prod DB cannot isolate MAX(s.observed_at) per provider from all other
 * markets' traffic, so semantics (null vs ~300s) are asserted without mutating snapshots.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeLiveFreshnessSnapshot,
  LIVE_FRESHNESS_SELECT,
} from "../../src/services/runtime-status.mjs";

function stalenessSecondsFromProviderTimestamp(latestIso, now) {
  if (!latestIso) return null;
  const lpTs = new Date(latestIso).getTime();
  return Math.max(0, Math.round((now.getTime() - lpTs) / 1000));
}

test("LIVE_FRESHNESS_SELECT bounds provider_market_snapshots to the last 15 minutes", () => {
  assert.match(
    LIVE_FRESHNESS_SELECT,
    /s\.observed_at\s*>\s*now\(\)\s*-\s*interval\s+'15 minutes'/i,
  );
});

test("staleness_seconds null when no snapshot in window (simulated row like only >15m-old data)", () => {
  const now = new Date("2026-04-28T12:00:00.000Z");
  const rts = {
    latest_snapshot_at: null,
    latest_kalshi_snapshot_at: null,
    latest_polymarket_snapshot_at: null,
    provider_markets_count: 100,
    snapshot_count: 4_000_000,
    families_count: 1,
    current_links_count: 1,
    observer_last_run: now.toISOString(),
  };
  assert.equal(stalenessSecondsFromProviderTimestamp(rts.latest_kalshi_snapshot_at, now), null);
  assert.equal(stalenessSecondsFromProviderTimestamp(rts.latest_polymarket_snapshot_at, now), null);
});

test("staleness_seconds ≈ 300 when latest snapshot is 5 minutes ago in window", () => {
  const now = new Date("2026-04-28T12:00:00.000Z");
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const kalshiLag = stalenessSecondsFromProviderTimestamp(fiveMinAgo, now);
  assert.ok(kalshiLag != null && Math.abs(kalshiLag - 300) < 2);
});

test("computeLiveFreshnessSnapshot returns mocked row (no live DB)", async () => {
  const row = {
    latest_snapshot_at: null,
    latest_kalshi_snapshot_at: null,
    latest_polymarket_snapshot_at: null,
    provider_markets_count: "1",
    snapshot_count: "2",
    families_count: 3,
    current_links_count: 4,
    observer_last_run: new Date().toISOString(),
  };
  const out = await computeLiveFreshnessSnapshot({
    query: async () => ({ rows: [row] }),
  });
  assert.deepEqual(out, row);
});
