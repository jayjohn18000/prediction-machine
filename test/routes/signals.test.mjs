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

async function getAnyCanonicalEventId(t) {
  let res;
  let body;
  await withEnv(t, async () => {
    res = await fetch(`${BASE_URL}/v1/canonical-events?category=politics`, {
      headers: { "x-pmci-api-key": process.env.PMCI_API_KEY ?? "" },
    });
    body = await res.json().catch(() => ({}));
  });

  if (res.status === 401) {
    t.skip("PMCI_API_KEY not accepted; skipping signals tests");
  }
  if (res.status !== 200 || !Array.isArray(body) || body.length === 0) {
    return null;
  }
  const first = body[0];
  return first?.id ?? null;
}

test("GET /v1/signals/top-divergences returns array for a known event", async (t) => {
  const eventId = await getAnyCanonicalEventId(t);
  if (!eventId) {
    t.skip("No canonical_events rows found for category=politics");
  }

  await withEnv(t, async () => {
    const res = await fetch(
      `${BASE_URL}/v1/signals/top-divergences?event_id=${encodeURIComponent(eventId)}&limit=5`,
      { headers: { "x-pmci-api-key": process.env.PMCI_API_KEY ?? "" } },
    );
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      t.skip("PMCI_API_KEY not accepted; skipping signals tests");
    }
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body));
    if (body.length > 0) {
      const item = body[0];
      assert.ok(typeof item.family_id === "number");
      assert.ok("max_divergence" in item);
      assert.ok(Array.isArray(item.legs));
    }
  });
});


