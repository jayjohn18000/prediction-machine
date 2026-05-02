/**
 * Tests for validateTickerForMM prod cross-check + selectMarketsForRotation rejection wiring.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateTickerForMM,
  selectMarketsForRotation,
} from "../../scripts/mm/rotate-demo-tickers.mjs";

const NOW_MS = Date.parse("2026-05-02T14:00:00.000Z");
const CLOSE_FAR = "2026-05-30T17:00:00.000Z";
const OPEN_PAST = "2026-05-01T12:00:00.000Z";

/** @returns {typeof fetch} prev */
function installFetch(fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = fn;
  return prev;
}

function baseEligible(/** @type {Record<string, unknown>} */ overrides = {}) {
  return {
    ticker: "KXUNITTEST-VALIDATOR",
    yes_bid_dollars: "0.46",
    yes_ask_dollars: "0.54",
    volume_24h_fp: "500",
    close_time: CLOSE_FAR,
    open_time: OPEN_PAST,
    ...overrides,
  };
}

function prodJsonBidAsk(bid, ask) {
  return {
    market: {
      ticker: "KXUNITTEST-VALIDATOR",
      yes_bid_dollars: bid,
      yes_ask_dollars: ask,
    },
  };
}

test("validateTickerForMM rejects locked-and-thin 1¢ spread with low volume", async () => {
  const prev = installFetch(async () => new Response("{}", { status: 404 }));
  try {
    const r = await validateTickerForMM(
      baseEligible({
        ticker: "KXTHIN",
        yes_bid_dollars: "0.49",
        yes_ask_dollars: "0.50",
        volume_24h_fp: "10",
      }),
      { nowMs: NOW_MS },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "locked_and_thin");
  } finally {
    globalThis.fetch = prev;
  }
});

test("validateTickerForMM passes locked 1¢ spread when volume ≥ 100", async () => {
  const prev = installFetch(async () => new Response("{}", { status: 404 }));
  try {
    const r = await validateTickerForMM(
      baseEligible({
        ticker: "KXLIQUID-LOCKED",
        yes_bid_dollars: "0.49",
        yes_ask_dollars: "0.50",
        volume_24h_fp: "10000",
      }),
      { nowMs: NOW_MS },
    );
    assert.equal(r.ok, true);
  } finally {
    globalThis.fetch = prev;
  }
});

test("validateTickerForMM rejects pre-event >12h out", async () => {
  const openFuture = new Date(NOW_MS + 24 * 3600 * 1000).toISOString();
  const prev = installFetch(async () => new Response("{}", { status: 404 }));
  try {
    const r = await validateTickerForMM(
      baseEligible({ open_time: openFuture }),
      { nowMs: NOW_MS },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "pre_event_dead_air");
  } finally {
    globalThis.fetch = prev;
  }
});

test("validateTickerForMM passes pre-event within 12h", async () => {
  const openSoon = new Date(NOW_MS + 6 * 3600 * 1000).toISOString();
  const prev = installFetch(async () => new Response("{}", { status: 404 }));
  try {
    const r = await validateTickerForMM(
      baseEligible({ open_time: openSoon }),
      { nowMs: NOW_MS },
    );
    assert.equal(r.ok, true);
  } finally {
    globalThis.fetch = prev;
  }
});

test("validateTickerForMM rejects demo_only_book when prod has no bid", async () => {
  const prev = installFetch(async (url) => {
    assert.match(String(url), /api\.elections\.kalshi\.com\/trade-api\/v2\/markets\//);
    return new Response(JSON.stringify(prodJsonBidAsk(null, null)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const r = await validateTickerForMM(baseEligible({ yes_bid_dollars: "0.50" }), {
      nowMs: NOW_MS,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "demo_only_book");
  } finally {
    globalThis.fetch = prev;
  }
});

test("validateTickerForMM passes when prod and demo mids align ~0.50", async () => {
  const prev = installFetch(async () => {
    return new Response(JSON.stringify(prodJsonBidAsk("0.49", "0.51")), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const r = await validateTickerForMM(
      baseEligible({ yes_bid_dollars: "0.49", yes_ask_dollars: "0.51" }),
      { nowMs: NOW_MS },
    );
    assert.equal(r.ok, true);
  } finally {
    globalThis.fetch = prev;
  }
});

test("validateTickerForMM rejects demo_prod_divergence when mids differ > 0.05", async () => {
  const prev = installFetch(async () => {
    return new Response(JSON.stringify(prodJsonBidAsk("0.60", "0.70")), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const r = await validateTickerForMM(
      baseEligible({ yes_bid_dollars: "0.49", yes_ask_dollars: "0.51" }),
      { nowMs: NOW_MS },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "demo_prod_divergence");
  } finally {
    globalThis.fetch = prev;
  }
});

test("validateTickerForMM passes when prod fetch throws (warn only)", async () => {
  const warnings = [];
  const logger = { warn: (m) => warnings.push(String(m)) };
  const prev = installFetch(async () => {
    throw new Error("network boom");
  });
  try {
    const r = await validateTickerForMM(baseEligible({ ticker: "KXNETFAIL" }), {
      nowMs: NOW_MS,
      logger,
    });
    assert.equal(r.ok, true);
    assert.ok(warnings.some((w) => w.includes("KXNETFAIL")), "expected ticker in warn");
  } finally {
    globalThis.fetch = prev;
  }
});

test("selectMarketsForRotation skips markets closing inside minCloseHours=48 window", async () => {
  const closesIn36h = new Date(NOW_MS + 36 * 3600 * 1000).toISOString();
  const { selections, rejected } = await selectMarketsForRotation(
    [
      baseEligible({
        ticker: "KXCLOSESOON",
        close_time: closesIn36h,
      }),
    ],
    { nowMs: NOW_MS, target: 8, minCloseHours: 48, skipProdCrossCheck: true },
  );
  assert.equal(selections.length, 0);
  assert.deepEqual(rejected, []);
});
