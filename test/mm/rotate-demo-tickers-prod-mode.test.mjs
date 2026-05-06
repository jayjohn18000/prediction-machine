// ADR-012 (2026-05-02): PROD rotator pulls PROD Kalshi directly; validateTickerForMM
// skips the legacy DEMO-vs-PROD cross-check in prod (no second fetch per ticker).
// Fail-closed cross-check behavior remains testable under runMode: "demo".
//
// Also verifies deriveHardPositionLimit clamps at the $30 notional cap per ADR-011 amended.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateTickerForMM,
  deriveHardPositionLimit,
  computeExpectedPriceCents,
} from "../../scripts/mm/rotate-demo-tickers.mjs";

describe("validateTickerForMM PROD skips legacy cross-check (ADR-012)", () => {
  const baseMarket = {
    ticker: "KX-FAKE-1",
    yes_bid_dollars: "0.40",
    yes_ask_dollars: "0.45",
    volume_24h_fp: "1000",
    open_time: new Date(Date.now() - 3600 * 1000).toISOString(), // already open
  };

  const fetchMustNotRun = async () => {
    throw new Error("fetch must not run in prod validateTickerForMM cross-check skip");
  };

  it("PROD mode skips cross-check and does not invoke fetch", async () => {
    const r = await validateTickerForMM(baseMarket, {
      runMode: "prod",
      fetch: fetchMustNotRun,
      logger: { warn: () => {} },
    });
    assert.equal(r.ok, true);
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

});

describe("deriveHardPositionLimit ($30 notional cap, ADR-011 amended 2026-05-02)", () => {
  it("DEMO mode returns the static demo value", () => {
    assert.equal(deriveHardPositionLimit("demo", 50), 20);
    assert.equal(deriveHardPositionLimit("demo", null), 20);
  });

  it("PROD mode at 50c → 60 contracts ($30 notional, clamped at ceiling)", () => {
    assert.equal(deriveHardPositionLimit("prod", 50), 60);
  });

  it("PROD mode at 99c → 30 contracts (≈$29.70 notional)", () => {
    assert.equal(deriveHardPositionLimit("prod", 99), 30);
  });

  it("PROD mode at 25c → clamped at ceiling of 60 (would be 120)", () => {
    assert.equal(deriveHardPositionLimit("prod", 25), 60);
  });

  it("PROD mode at 1c → clamped at ceiling of 60", () => {
    assert.equal(deriveHardPositionLimit("prod", 1), 60);
  });

  it("PROD mode at 75c → 40 contracts ($30 notional)", () => {
    assert.equal(deriveHardPositionLimit("prod", 75), 40);
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
