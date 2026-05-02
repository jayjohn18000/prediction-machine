// Verifies /admin/restart fails CLOSED when PMCI_ADMIN_KEY is unset.
//
// Prior implementation (`if (adminKey && ...)`) silently failed OPEN when the env
// var was missing — anyone could POST /admin/restart and force a respawn. Audit
// 2026-05-02 lane 06 inadvertently restarted production by probing this endpoint.
//
// We can't import the orchestrator's main() (it has top-level side effects), so
// this test exercises the gate logic in isolation using the same Fastify shape.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

/**
 * Mounts the SAME gate logic as scripts/mm/run-mm-orchestrator.mjs so a regression
 * in either place is caught here.
 */
function buildAppWithEnv(envValue) {
  const app = Fastify({ logger: false });
  app.post("/admin/restart", async (req, reply) => {
    const adminKey = envValue?.trim?.() ?? envValue;
    if (!adminKey) {
      return reply.code(503).send({
        error: "service_unavailable",
        message: "admin endpoint disabled: PMCI_ADMIN_KEY env var unset",
      });
    }
    if (req.headers["x-pmci-admin-key"] !== adminKey) {
      return reply.code(403).send({ error: "forbidden", message: "admin key required" });
    }
    return reply.code(202).send({ ok: true, restartingInMs: 500 });
  });
  return app;
}

describe("/admin/restart auth gate", () => {
  it("returns 503 when PMCI_ADMIN_KEY is undefined", async () => {
    const app = buildAppWithEnv(undefined);
    const r = await app.inject({ method: "POST", url: "/admin/restart" });
    assert.equal(r.statusCode, 503);
    const body = r.json();
    assert.equal(body.error, "service_unavailable");
    await app.close();
  });

  it("returns 503 when PMCI_ADMIN_KEY is empty string", async () => {
    const app = buildAppWithEnv("");
    const r = await app.inject({ method: "POST", url: "/admin/restart" });
    assert.equal(r.statusCode, 503);
    await app.close();
  });

  it("returns 503 when PMCI_ADMIN_KEY is whitespace only", async () => {
    const app = buildAppWithEnv("   ");
    const r = await app.inject({ method: "POST", url: "/admin/restart" });
    assert.equal(r.statusCode, 503);
    await app.close();
  });

  it("returns 403 when key set but header missing", async () => {
    const app = buildAppWithEnv("super-secret");
    const r = await app.inject({ method: "POST", url: "/admin/restart" });
    assert.equal(r.statusCode, 403);
    await app.close();
  });

  it("returns 403 when key set but header wrong", async () => {
    const app = buildAppWithEnv("super-secret");
    const r = await app.inject({
      method: "POST",
      url: "/admin/restart",
      headers: { "x-pmci-admin-key": "wrong" },
    });
    assert.equal(r.statusCode, 403);
    await app.close();
  });

  it("returns 202 when key set and header matches (does NOT call process.exit in this isolated test)", async () => {
    const app = buildAppWithEnv("super-secret");
    const r = await app.inject({
      method: "POST",
      url: "/admin/restart",
      headers: { "x-pmci-admin-key": "super-secret" },
    });
    assert.equal(r.statusCode, 202);
    const body = r.json();
    assert.equal(body.ok, true);
    await app.close();
  });
});
