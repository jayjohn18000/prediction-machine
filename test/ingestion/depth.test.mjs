/**
 * Unit tests for lib/ingestion/depth.mjs
 *
 * Covers the pure state helpers (applySnapshot, applyDelta, topKLevels,
 * computeMidAndSpread, buildDepthRow, handleMessage) and the Supabase writer
 * shape (idempotent upsert options).
 *
 * A one-shot live demo run against wss://demo-api.kalshi.co/trade-api/ws/v2 is
 * performed separately by scripts/ingestion/mm-depth-oneshot.mjs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySnapshot,
  applyDelta,
  topKLevels,
  computeMidAndSpread,
  buildDepthRow,
  handleMessage,
  makeEmptyBook,
  makeSupabaseWriter,
  reconnectBackoffMs,
  resetDepthStateForReconnect,
  secondsSinceLastUpdate,
  startDownsampler,
  wrapDepthRowWriter,
} from "../../lib/ingestion/depth.mjs";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

// ---------------------------------------------------------------------------
// applySnapshot
// ---------------------------------------------------------------------------

test("applySnapshot replaces book state from both sides", () => {
  const book = makeEmptyBook();
  book.yes.set(55, 100); // stale level — must be cleared
  book.no.set(40, 200);  // stale level — must be cleared
  applySnapshot(book, {
    yes: [[50, 200], [49, 100]],
    no: [[48, 150]],
  });
  assert.equal(book.yes.size, 2);
  assert.equal(book.yes.get(50), 200);
  assert.equal(book.yes.get(49), 100);
  assert.equal(book.yes.has(55), false);
  assert.equal(book.no.size, 1);
  assert.equal(book.no.get(48), 150);
  assert.equal(book.no.has(40), false);
  assert.notEqual(book.lastUpdateMs, null);
});

test("applySnapshot drops zero-qty levels", () => {
  const book = makeEmptyBook();
  applySnapshot(book, { yes: [[50, 100], [49, 0]], no: [[48, 0]] });
  assert.equal(book.yes.size, 1);
  assert.equal(book.no.size, 0);
});

// ---------------------------------------------------------------------------
// applyDelta
// ---------------------------------------------------------------------------

test("applyDelta updates existing level and adds new level", () => {
  const book = makeEmptyBook();
  applySnapshot(book, { yes: [[50, 100]], no: [[48, 50]] });
  applyDelta(book, { yes: [[50, 150], [51, 20]] });
  assert.equal(book.yes.get(50), 150);
  assert.equal(book.yes.get(51), 20);
  assert.equal(book.no.get(48), 50); // unaffected
});

test("applyDelta with qty=0 removes a level", () => {
  const book = makeEmptyBook();
  applySnapshot(book, { yes: [[50, 100], [49, 50]], no: [[48, 80]] });
  applyDelta(book, { yes: [[49, 0]], no: [[48, 0]] });
  assert.equal(book.yes.has(49), false);
  assert.equal(book.yes.size, 1);
  assert.equal(book.no.size, 0);
});

test("applyDelta with qty=null removes a level", () => {
  const book = makeEmptyBook();
  applySnapshot(book, { yes: [[50, 100]], no: [] });
  applyDelta(book, { yes: [[50, null]] });
  assert.equal(book.yes.size, 0);
});

test("applyDelta ignores missing side (no yes or no key)", () => {
  const book = makeEmptyBook();
  applySnapshot(book, { yes: [[50, 100]], no: [[48, 50]] });
  applyDelta(book, { yes: [[50, 200]] }); // no 'no' field
  assert.equal(book.yes.get(50), 200);
  assert.equal(book.no.get(48), 50); // untouched
});

// ---------------------------------------------------------------------------
// topKLevels
// ---------------------------------------------------------------------------

test("topKLevels returns top-k by price descending", () => {
  const m = new Map([[48, 1], [50, 2], [49, 3], [51, 4], [47, 5]]);
  const top = topKLevels(m, 3);
  assert.deepEqual(top, [[51, 4], [50, 2], [49, 3]]);
});

test("topKLevels handles fewer than k levels", () => {
  const m = new Map([[50, 2]]);
  const top = topKLevels(m, 10);
  assert.deepEqual(top, [[50, 2]]);
});

test("topKLevels on empty map returns empty array", () => {
  assert.deepEqual(topKLevels(new Map(), 10), []);
});

// ---------------------------------------------------------------------------
// computeMidAndSpread
// ---------------------------------------------------------------------------

test("computeMidAndSpread normal case", () => {
  const book = makeEmptyBook();
  applySnapshot(book, { yes: [[50, 100]], no: [[48, 50]] });
  // yes_ask = 100 - 48 = 52; mid = (50 + 52) / 2 = 51; spread = 52 - 50 = 2
  assert.deepEqual(computeMidAndSpread(book), { mid_cents: 51, spread_cents: 2 });
});

test("computeMidAndSpread picks best (highest) level on each side", () => {
  const book = makeEmptyBook();
  applySnapshot(book, { yes: [[45, 100], [50, 10]], no: [[40, 80], [48, 5]] });
  // best_yes_bid=50, best_no_bid=48 -> yes_ask=52 -> mid=51, spread=2
  assert.deepEqual(computeMidAndSpread(book), { mid_cents: 51, spread_cents: 2 });
});

test("computeMidAndSpread returns null when yes side empty", () => {
  const book = makeEmptyBook();
  applySnapshot(book, { yes: [], no: [[48, 50]] });
  assert.deepEqual(computeMidAndSpread(book), { mid_cents: null, spread_cents: null });
});

test("computeMidAndSpread returns null when no side empty", () => {
  const book = makeEmptyBook();
  applySnapshot(book, { yes: [[50, 100]], no: [] });
  assert.deepEqual(computeMidAndSpread(book), { mid_cents: null, spread_cents: null });
});

test("computeMidAndSpread returns null on crossed book", () => {
  const book = makeEmptyBook();
  // yes bid 60, no bid 45 -> yes ask = 55, but yes bid (60) > yes ask (55) => crossed
  applySnapshot(book, { yes: [[60, 100]], no: [[45, 50]] });
  assert.deepEqual(computeMidAndSpread(book), { mid_cents: null, spread_cents: null });
});

// ---------------------------------------------------------------------------
// buildDepthRow — deterministic output per (marketId, observedAtMs)
// ---------------------------------------------------------------------------

test("buildDepthRow produces deterministic row for (marketId, observed_at)", () => {
  const book = makeEmptyBook();
  applySnapshot(book, { yes: [[50, 100]], no: [[48, 50]] });
  const ts = 1704000000000;
  const row1 = buildDepthRow(book, { providerMarketId: 42, observedAtMs: ts });
  const row2 = buildDepthRow(book, { providerMarketId: 42, observedAtMs: ts });
  assert.equal(row1.provider_market_id, 42);
  assert.equal(row1.observed_at, row2.observed_at);
  assert.deepEqual(row1.yes_levels, row2.yes_levels);
  assert.deepEqual(row1.no_levels, row2.no_levels);
  assert.equal(row1.mid_cents, row2.mid_cents);
  assert.equal(row1.spread_cents, row2.spread_cents);
});

test("buildDepthRow caps levels at TOP_K (10) per side", () => {
  const book = makeEmptyBook();
  const yesLevels = [];
  const noLevels = [];
  for (let p = 1; p <= 15; p += 1) {
    yesLevels.push([p, 10]);
    noLevels.push([p, 20]);
  }
  applySnapshot(book, { yes: yesLevels, no: noLevels });
  const row = buildDepthRow(book, { providerMarketId: 99, observedAtMs: Date.now() });
  assert.equal(row.yes_levels.length, 10);
  assert.equal(row.no_levels.length, 10);
  // Top of ladder should be price 15 on both sides.
  assert.equal(row.yes_levels[0][0], 15);
  assert.equal(row.no_levels[0][0], 15);
});

// ---------------------------------------------------------------------------
// handleMessage — dispatch by type
// ---------------------------------------------------------------------------

test("handleMessage dispatches orderbook_snapshot by ticker", () => {
  const books = new Map([["T1", makeEmptyBook()]]);
  handleMessage(
    { type: "orderbook_snapshot", msg: { market_ticker: "T1", yes: [[50, 100]], no: [[48, 50]] } },
    books,
    silent,
  );
  const book = books.get("T1");
  assert.equal(book.yes.get(50), 100);
  assert.equal(book.no.get(48), 50);
});

test("handleMessage dispatches orderbook_delta by ticker", () => {
  const books = new Map([["T1", makeEmptyBook()]]);
  handleMessage(
    { type: "orderbook_snapshot", msg: { market_ticker: "T1", yes: [[50, 100]], no: [[48, 50]] } },
    books,
    silent,
  );
  handleMessage(
    { type: "orderbook_delta", msg: { market_ticker: "T1", yes: [[50, 200]] } },
    books,
    silent,
  );
  assert.equal(books.get("T1").yes.get(50), 200);
});

test("handleMessage ignores messages for unsubscribed tickers", () => {
  const books = new Map([["T1", makeEmptyBook()]]);
  handleMessage(
    { type: "orderbook_snapshot", msg: { market_ticker: "OTHER", yes: [[50, 100]] } },
    books,
    silent,
  );
  assert.equal(books.get("T1").yes.size, 0);
});

test("handleMessage handles subscribed ack without error", () => {
  const books = new Map([["T1", makeEmptyBook()]]);
  handleMessage({ type: "subscribed", msg: { sid: 123, market_ticker: "T1" } }, books, silent);
  assert.equal(books.get("T1").yes.size, 0); // no book mutation
});

test("handleMessage handles error payload without throwing", () => {
  const books = new Map();
  assert.doesNotThrow(() => {
    handleMessage({ type: "error", msg: { code: 1, message: "bad" } }, books, silent);
  });
});

test("handleMessage ignores malformed messages (no type)", () => {
  const books = new Map([["T1", makeEmptyBook()]]);
  handleMessage({}, books, silent);
  handleMessage(null, books, silent);
  handleMessage({ msg: {} }, books, silent);
  assert.equal(books.get("T1").yes.size, 0);
});

// ---------------------------------------------------------------------------
// Supabase writer — verify idempotent upsert options are passed through
// ---------------------------------------------------------------------------

test("makeSupabaseWriter passes idempotent upsert options", async () => {
  const calls = [];
  const fakeSupabase = {
    schema: (s) => ({
      from: (t) => ({
        upsert: async (row, opts) => {
          calls.push({ schema: s, table: t, row, opts });
          return { error: null };
        },
      }),
    }),
  };
  const write = makeSupabaseWriter(fakeSupabase);
  const row = {
    provider_market_id: 1,
    observed_at: new Date(1704000000000).toISOString(),
    yes_levels: [[50, 100]],
    no_levels: [[48, 50]],
    mid_cents: 51,
    spread_cents: 2,
  };
  await write(row);
  await write(row); // duplicate — handler should still forward; DB-level constraint drops it

  assert.equal(calls.length, 2);
  assert.equal(calls[0].schema, "pmci");
  assert.equal(calls[0].table, "provider_market_depth");
  assert.equal(calls[0].opts.onConflict, "provider_market_id,observed_at");
  assert.equal(calls[0].opts.ignoreDuplicates, true);
  // Both calls forwarded identical rows; DB UNIQUE constraint enforces idempotency.
  assert.deepEqual(calls[0].row, calls[1].row);
});

test("wrapDepthRowWriter skips insert when yes_levels empty and logs warn", async () => {
  const writes = [];
  const warns = [];
  const infos = [];
  const inner = async (row) => writes.push(row);
  const wrap = wrapDepthRowWriter(inner, {
    info: (...a) => infos.push(a),
    warn: (...a) => warns.push(a),
    error: () => {},
  });
  await wrap({
    provider_market_id: 1,
    observed_at: new Date(0).toISOString(),
    yes_levels: [],
    no_levels: [[48, 1]],
    mid_cents: null,
    spread_cents: null,
  });
  assert.equal(writes.length, 0);
  assert.ok(warns.some((w) => String(w[0]).includes("skip_empty_yes")));
  await wrap({
    provider_market_id: 2,
    observed_at: new Date(1).toISOString(),
    yes_levels: [[50, 1]],
    no_levels: [[48, 1]],
    mid_cents: 51,
    spread_cents: 2,
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].provider_market_id, 2);
});

test("makeSupabaseWriter surfaces DB errors via logger but does not throw", async () => {
  const errors = [];
  const fakeSupabase = {
    schema: () => ({
      from: () => ({
        upsert: async () => ({ error: { message: "unique violation" } }),
      }),
    }),
  };
  const write = makeSupabaseWriter(fakeSupabase, {
    logger: { info: () => {}, warn: () => {}, error: (...args) => errors.push(args) },
  });
  await assert.doesNotReject(async () => write({ provider_market_id: 1, observed_at: "x", yes_levels: [], no_levels: [] }));
  assert.equal(errors.length, 1);
});

// ---------------------------------------------------------------------------
// D1/D2/D3 — reconnect backoff, staleness, snapshot gating (Group D)
// ---------------------------------------------------------------------------

test("reconnectBackoffMs is exponential 1s…16s capped at 30s", () => {
  assert.equal(reconnectBackoffMs(0), 1000);
  assert.equal(reconnectBackoffMs(1), 2000);
  assert.equal(reconnectBackoffMs(2), 4000);
  assert.equal(reconnectBackoffMs(3), 8000);
  assert.equal(reconnectBackoffMs(4), 16_000);
  assert.equal(reconnectBackoffMs(5), 30_000);
  assert.equal(reconnectBackoffMs(6), 30_000);
});

test("resetDepthStateForReconnect clears in-memory book and snapshot flags", () => {
  const books = new Map([["T1", makeEmptyBook()]]);
  applySnapshot(books.get("T1"), { yes: [[50, 100]], no: [[48, 50]] });
  const snapshotReceived = new Map([["T1", true]]);
  resetDepthStateForReconnect(books, ["T1"], snapshotReceived);
  assert.equal(books.get("T1").yes.size, 0);
  assert.equal(books.get("T1").no.size, 0);
  assert.equal(books.get("T1").lastUpdateMs, null);
  assert.equal(snapshotReceived.get("T1"), false);
});

test("secondsSinceLastUpdate returns Infinity before first frame", () => {
  const books = new Map([["T1", makeEmptyBook()]]);
  assert.equal(Number.POSITIVE_INFINITY, secondsSinceLastUpdate("T1", books));
  assert.equal(Number.POSITIVE_INFINITY, secondsSinceLastUpdate("T2", books));
});

test("startDownsampler skips rows when snapshotReceived is false for that ticker", async () => {
  const books = new Map([["T1", makeEmptyBook()]]);
  applySnapshot(books.get("T1"), { yes: [[50, 100]], no: [[48, 50]] });
  const snapshotReceived = new Map([["T1", false]]);
  const blocked = [];
  const stop1 = startDownsampler({
    books,
    tickerToProviderMarketId: new Map([["T1", 1]]),
    onRow: (r) => blocked.push(r),
    intervalMs: 20,
    logger: silent,
    snapshotReceived,
  });
  await new Promise((r) => setTimeout(r, 70));
  stop1();
  assert.equal(blocked.length, 0);

  snapshotReceived.set("T1", true);
  const allowed = [];
  const stop2 = startDownsampler({
    books,
    tickerToProviderMarketId: new Map([["T1", 1]]),
    onRow: (r) => allowed.push(r),
    intervalMs: 20,
    logger: silent,
    snapshotReceived,
  });
  await new Promise((r) => setTimeout(r, 70));
  stop2();
  assert.ok(allowed.length >= 1);
});

test("handleMessage sets snapshotReceived when orderbook_snapshot and map provided", () => {
  const books = new Map([["T1", makeEmptyBook()]]);
  const snapshotReceived = new Map([["T1", false]]);
  handleMessage(
    { type: "orderbook_snapshot", msg: { market_ticker: "T1", yes: [[50, 100]], no: [[48, 50]] } },
    books,
    silent,
    { snapshotReceived },
  );
  assert.equal(snapshotReceived.get("T1"), true);
});
