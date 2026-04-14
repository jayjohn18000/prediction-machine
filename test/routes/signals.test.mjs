/**
 * Top-divergences: inject tests with mocked DB (no live API required).
 * Integration-style fetch tests are optional when API_BASE_URL points at a running server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { registerSignalsRoutes } from "../../src/routes/signals.mjs";

const BASE_URL = process.env.API_BASE_URL || "http://localhost:8787";

function isSoftLagQuery(sql) {
  return String(sql).includes("extract(epoch from (now() - max(observed_at)))");
}

async function buildSignalsApp(mockQuery) {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { global: false });

  const deps = {
    query: mockQuery,
    SQL: {},
    assertFreshness: async () => {
      assert.fail("assertFreshness must not run for top-divergences");
    },
    RATE_LIMIT_CONFIG: { max: 1000, timeWindow: 1000 },
    z,
  };

  registerSignalsRoutes(app, deps);
  await app.ready();
  return app;
}

test("GET /v1/signals/top-divergences (inject, global) returns data_lag_seconds and families", async () => {
  const mockQuery = async (sql, params) => {
    if (isSoftLagQuery(sql)) {
      assert.ok(!String(sql).includes("with latest_snapshots"));
      return { rows: [{ lag_seconds: 42 }] };
    }
    assert.ok(String(sql).includes("with latest_snapshots"));
    assert.deepEqual(params, [5]);
    return { rows: [] };
  };

  const app = await buildSignalsApp(mockQuery);
  const res = await app.inject({ method: "GET", url: "/v1/signals/top-divergences?limit=5" });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.data_lag_seconds, 42);
  assert.ok(Array.isArray(body.families));
  assert.deepEqual(body.families, []);
});

test("GET /v1/signals/top-divergences (inject, per-event) passes event_id into query", async () => {
  const eventId = "c8515a58-c984-46fe-ac65-25e362e68333";
  const mockQuery = async (sql, params) => {
    if (isSoftLagQuery(sql)) {
      return { rows: [{ lag_seconds: 0 }] };
    }
    assert.ok(String(sql).includes("f.canonical_event_id = $1"));
    assert.deepEqual(params, [eventId, 5]);
    return { rows: [] };
  };

  const app = await buildSignalsApp(mockQuery);
  const res = await app.inject({
    method: "GET",
    url: `/v1/signals/top-divergences?event_id=${eventId}&limit=5`,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.data_lag_seconds, 0);
  assert.ok(Array.isArray(body.families));
});

test("GET /v1/signals/top-divergences (inject, category) joins canonical_events and filters", async () => {
  const mockQuery = async (sql, params) => {
    if (isSoftLagQuery(sql)) {
      return { rows: [{ lag_seconds: null }] };
    }
    const s = String(sql);
    assert.ok(s.includes("join pmci.canonical_events ce on ce.id = f.canonical_event_id"));
    assert.ok(s.includes("ce.category = $1"));
    assert.deepEqual(params, ["politics", 10]);
    return { rows: [] };
  };

  const app = await buildSignalsApp(mockQuery);
  const res = await app.inject({
    method: "GET",
    url: "/v1/signals/top-divergences?category=politics&limit=10",
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.data_lag_seconds, null);
  assert.ok(Array.isArray(body.families));
});

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
    t.skip("PMCI_API_KEY not accepted; skipping live API signals tests");
  }
  if (res.status !== 200 || !Array.isArray(body) || body.length === 0) {
    return null;
  }
  const first = body[0];
  return first?.id ?? null;
}

function assertTopDivergencesEnvelope(body) {
  assert.ok(body && typeof body === "object");
  assert.ok("data_lag_seconds" in body);
  assert.ok(Array.isArray(body.families));
  if (body.families.length > 0) {
    const item = body.families[0];
    assert.ok(typeof item.family_id === "number");
    assert.ok("max_divergence" in item);
    assert.ok(Array.isArray(item.legs));
  }
}

test("GET /v1/signals/top-divergences (live, global) returns envelope when API is new", async (t) => {
  await withEnv(t, async () => {
    const res = await fetch(`${BASE_URL}/v1/signals/top-divergences?limit=5`, {
      headers: { "x-pmci-api-key": process.env.PMCI_API_KEY ?? "" },
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      t.skip("PMCI_API_KEY not accepted; skipping live API signals tests");
    }
    if (res.status === 503) {
      t.skip("Live API returned 503 (stale gate or old build); inject tests cover the new contract");
      return;
    }
    assert.equal(res.status, 200);
    assertTopDivergencesEnvelope(body);
  });
});

test("GET /v1/signals/top-divergences (live, per-event) returns envelope when API is new", async (t) => {
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
      t.skip("PMCI_API_KEY not accepted; skipping live API signals tests");
    }
    if (res.status === 503) {
      t.skip("Live API returned 503 (stale gate or old build); inject tests cover the new contract");
      return;
    }
    assert.equal(res.status, 200);
    assertTopDivergencesEnvelope(body);
  });
});
