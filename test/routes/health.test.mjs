import test from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.API_BASE_URL || "http://localhost:8787";

async function fetchJson(path) {
  const url = `${BASE_URL}${path}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    if (code === "ECONNREFUSED") {
      throw Object.assign(new Error(`API not running at ${BASE_URL}`), { skip: true });
    }
    throw err;
  }
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

test("GET /v1/health/freshness returns status and counts", async (t) => {
  try {
    const { res, body } = await fetchJson("/v1/health/freshness");
    assert.equal(res.status, 200);
    assert.ok(["ok", "stale", "error"].includes(body.status));
    assert.ok(typeof body.counts?.provider_markets === "number");
    assert.ok(typeof body.counts?.snapshots === "number");
  } catch (err) {
    if (err.skip) t.skip(err.message);
    throw err;
  }
});

test("GET /v1/health/slo returns SLO summary", async (t) => {
  try {
    const { res, body } = await fetchJson("/v1/health/slo");
    assert.equal(res.status, 200);
    assert.ok(["ok", "degraded"].includes(body.status));
    assert.ok(body.request_metrics);
    assert.ok(body.db_metrics);
  } catch (err) {
    if (err.skip) t.skip(err.message);
    throw err;
  }
});

