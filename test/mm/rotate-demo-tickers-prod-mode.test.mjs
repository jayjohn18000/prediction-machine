// ADR-011 cutover gate (lane 17): in PROD mode, validateTickerForMM's
// cross-check error paths MUST flip from "best-effort skip" (`{ ok: true }`)
// to "required pass" (`{ ok: false, reason: "prod_cross_check_unavailable" }`).
//
// Audit 2026-05-02 lane 17 verdict was DEGRADED-FAIL because the validator
// silently passed on every error path. This test guards against regression.
//
// Also verifies deriveHardPositionLimit clamps at the $50 notional cap per ADR-011.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateTickerForMM,
  deriveHardPositionLimit,
  computeExpectedPriceCents,
} from "../../scripts/mm/rotate-demo-tickers.mjs";

describe("validateTickerForMM PROD cross-check fail-closed", () => {
  const baseMarket = {
    ticker: "KX-FAKE-1",
    yes_bid_dollars: "0.40",
    yes_ask_dollars: "0.45",
    volume_24h_fp: "1000",
    open_time: new Date(Date.now() - 3600 * 1000).toISOString(), // already open
  };

  it("PROD mode returns { ok: false } on network error", async () => {
    const r = await validateTickerForMM(baseMarket, {
      runMode: "prod",
      fetch: async () => {
        throw new Error("ENOTFOUND prod.example");
      },
      logger: { warn: () => {} },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "prod_cross_check_unavailable");
  });

  it("PROD mode returns { ok: false } on HTTP 500", async () => {
    const r = await validateTickerForMM(baseMarket, {
      runMode: "prod",
      fetch: async () => /** @type {any} */ ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }),
      logger: { warn: () => {} },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "prod_cross_check_unavailable");
  });

  it("PROD mode returns { ok: false } on JSON parse error", async () => {
    const r = await validateTickerForMM(baseMarket, {
      runMode: "prod",
      fetch: async () => /** @type {any} */ ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("invalid JSON");
        },
      }),
      logger: { warn: () => {} },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "prod_cross_check_unavailable");
  });

  it("DEMO mode returns { ok: true } on network error (best-effort skip preserved)", async () => {
    const r = await validateTickerForMM(baseMarket, {
      runMode: "demo",
      fetch: async () => {
        throw new Error("ENOTFOUND prod.example");
      },
      logger: { warn: () => {} },
    });
    assert.equal(r.ok, true);
  });

  it("PROD mode passes when prod book matches demo book", async () => {
    const prodBody = {
      market: { yes_bid_dollars: "0.41", yes_ask_dollars: "0.46" },
    };
    const r = await validateTickerForMM(baseMarket, {
      runMode: "prod",
      fetch: async () => /** @type {any} */ ({
        ok: true,
        status: 200,
        json: async () => prodBody,
      }),
      logger: { warn: () => {} },
    });
    assert.equal(r.ok, true);
  });
});

describe("deriveHardPositionLimit ($50 notional cap, ADR-011)", () => {
  it("DEMO mode returns the static demo value", () => {
    assert.equal(deriveHardPositionLimit("demo", 50), 20);
    assert.equal(deriveHardPositionLimit("demo", null), 20);
  });

  it("PROD mode at 50c → 100 contracts ($50 notional)", () => {
    assert.equal(deriveHardPositionLimit("prod", 50), 100);
  });

  it("PROD mode at 99c → 50 contracts (≈$49.50 notional)", () => {
    assert.equal(deriveHardPositionLimit("prod", 99), 50);
  });

  it("PROD mode at 25c → clamped at ceiling of 100 (would be 200)", () => {
    assert.equal(deriveHardPositionLimit("prod", 25), 100);
  });

  it("PROD mode at 1c → clamped at ceiling of 100", () => {
    assert.equal(deriveHardPositionLimit("prod", 1), 100);
  });

  it("PROD mode with null price → conservative floor 5", () => {
    assert.equal(deriveHardPositionLimit("prod", null), 5);
  });

  it("PROD mode with 0 / negative → conservative floor 5", () => {
    assert.equal(deriveHardPositionLimit("prod", 0), 5);
    assert.equal(deriveHardPositionLimit("prod", -5), 5);
  });
});

describe("computeExpectedPriceCents", () => {
  it("returns YES mid when both sides present", () => {
    assert.equal(
      computeExpectedPriceCents({ yes_bid_dollars: "0.49", yes_ask_dollars: "0.51" }),
      50,
    );
  });

  it("falls back to last_price when bid/ask unavailable", () => {
    assert.equal(computeExpectedPriceCents({ last_price_dollars: "0.42" }), 42);
  });

  it("returns null when no price signal", () => {
    assert.equal(computeExpectedPriceCents({}), null);
    assert.equal(computeExpectedPriceCents(null), null);
  });
});
