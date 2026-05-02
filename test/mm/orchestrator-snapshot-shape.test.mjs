import test from "node:test";
import assert from "node:assert/strict";
import { fetchKalshiMarketSnapshot } from "../../lib/mm/orchestrator.mjs";

test("fetchKalshiMarketSnapshot returns bestBidCents and bestAskCents", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      market: {
        yes_bid: 45,
        yes_ask: 55,
        volume_24h: 1000,
      },
    }),
  });
  try {
    const snap = await fetchKalshiMarketSnapshot("https://demo-api.kalshi.co/trade-api/v2", "KX-MOCK");
    assert.equal(snap.bestBidCents, 45);
    assert.equal(snap.bestAskCents, 55);
    assert.equal(snap.midCents, 50);
    assert.equal(snap.spreadCents, 10);
    assert.ok(snap.weightKalshiLiquidity >= 1);
    assert.ok(typeof snap.observedAtMs === "number");
  } finally {
    globalThis.fetch = original;
  }
});
