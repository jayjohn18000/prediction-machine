import test from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.API_BASE_URL || "http://localhost:8787";

async function withEnv(t, fn) {
  const { loadEnv } = await import("../../src/platform/env.mjs");
  loadEnv();
  try {
    await fn();
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    if (code === "ECONNREFUSED") {
      t.skip(`API not running at ${BASE_URL}`);
    }
    throw err;
  }
}

test("GET /v1/coverage for kalshi returns coverage stats", async (t) => {
  await withEnv(t, async () => {
    const res = await fetch(`${BASE_URL}/v1/coverage?provider=kalshi`, {
      headers: { "x-pmci-api-key": process.env.PMCI_API_KEY ?? "" },
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      t.skip("PMCI_API_KEY not accepted; skipping coverage test");
    }
    assert.equal(res.status, 200);
    if (body.error === "unknown_provider") {
      t.skip("kalshi provider not present in pmci.providers");
    }
    assert.equal(body.provider, "kalshi");
    assert.ok(typeof body.total_markets === "number");
    assert.ok(typeof body.matched_markets === "number");
    assert.ok(typeof body.coverage_ratio === "number");
  });
});

test("GET /v1/coverage/summary for kalshi returns summary stats", async (t) => {
  await withEnv(t, async () => {
    const res = await fetch(`${BASE_URL}/v1/coverage/summary?provider=kalshi`, {
      headers: { "x-pmci-api-key": process.env.PMCI_API_KEY ?? "" },
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      t.skip("PMCI_API_KEY not accepted; skipping coverage summary test");
    }
    assert.equal(res.status, 200);
    if (body.error === "unknown_provider") {
      t.skip("kalshi provider not present in pmci.providers");
    }
    assert.equal(body.provider, "kalshi");
    assert.ok(typeof body.total_markets === "number");
    assert.ok(typeof body.linked_markets === "number");
    assert.ok(typeof body.unlinked_markets === "number");
    assert.ok(typeof body.coverage_ratio === "number");
  });
});


