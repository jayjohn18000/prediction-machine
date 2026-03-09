/**
 * Unit tests for review route idempotency and atomicity.
 *
 * These tests run without a live DB. The `withTransaction` dep is mocked so
 * individual query sequences can be controlled and inspected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { SQL } from "../../src/queries.mjs";
import { registerReviewRoutes } from "../../src/routes/review.mjs";
import { withTransaction } from "../../src/db.mjs";

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a txQuery mock that pops responses from `responses` in order.
 * Extra calls beyond the list return { rows: [], rowCount: 0 }.
 */
function makeQuerySeq(...responses) {
  let i = 0;
  return async (_sql, _params) => responses[i++] ?? { rows: [], rowCount: 0 };
}

/**
 * Build a minimal Fastify app with mock deps for review route unit tests.
 *
 * @param {(fn: Function) => Promise<any>} mockWithTransaction
 */
async function buildApp(mockWithTransaction) {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { global: false });

  const deps = {
    z,
    SQL,
    RATE_LIMIT_CONFIG: { max: 1000, timeWindow: 1000 },
    query: async () => ({ rows: [], rowCount: 0 }),
    withTransaction: mockWithTransaction,
  };

  registerReviewRoutes(app, deps);
  await app.ready();
  return app;
}

function postDecision(app, body) {
  return app.inject({
    method: "POST",
    url: "/v1/review/decision",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postResolve(app, body, adminKey = "") {
  return app.inject({
    method: "POST",
    url: "/v1/resolve/link",
    headers: { "content-type": "application/json", "x-pmci-admin-key": adminKey },
    body: JSON.stringify(body),
  });
}

// ─── withTransaction unit tests ───────────────────────────────────────────────

test("withTransaction: commits on success and returns fn result", async () => {
  const calls = [];
  const fakeClient = {
    query: async (sql) => {
      calls.push(sql);
      return { rows: [{ id: 99 }], rowCount: 1 };
    },
    release: () => {},
  };
  const fakePool = { connect: async () => fakeClient };

  const result = await withTransaction(async (txQuery) => {
    const res = await txQuery("SELECT 1");
    return { value: res.rows[0].id };
  }, { _pool: fakePool });

  assert.deepEqual(calls, ["BEGIN", "SELECT 1", "COMMIT"]);
  assert.deepEqual(result, { value: 99 });
});

test("withTransaction: rolls back and rethrows on error", async () => {
  const calls = [];
  const fakeClient = {
    query: async (sql) => {
      calls.push(sql);
      if (sql === "SELECT boom") throw new Error("simulated db error");
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const fakePool = { connect: async () => fakeClient };

  await assert.rejects(
    () => withTransaction(async (txQuery) => { await txQuery("SELECT boom"); }, { _pool: fakePool }),
    /simulated db error/,
  );

  assert.deepEqual(calls, ["BEGIN", "SELECT boom", "ROLLBACK"]);
});

// ─── review decision — accept idempotency ─────────────────────────────────────

test("POST /v1/review/decision accept: returns error when proposal already decided", async () => {
  // Simulate second accept: FOR UPDATE finds no undecided proposal
  const mock = async (fn) => fn(makeQuerySeq({ rows: [], rowCount: 0 }));
  const app = await buildApp(mock);

  const res = await postDecision(app, {
    proposed_id: 42,
    decision: "accept",
    relationship_type: "equivalent",
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.error, "proposal_not_found_or_already_decided");
});

test("POST /v1/review/decision accept: succeeds on first call (happy path)", async () => {
  // Sequences per SQL call inside the transaction:
  // 1. FOR UPDATE proposal fetch → one row
  // 2. market fetch → market A and B rows
  // 3. family label lookup → not found
  // 4. canonical event lookup → not found
  // 5. INSERT family → id=10
  // 6. next_linker_run_version → 1
  // 7. insert_linker_run → ok
  // 8. insert_market_link (market A) → link row
  // 9. insert_market_link (market B) → link row
  // 10. UPDATE proposed_links → ok
  // 11. INSERT review_decisions → ok
  // 12. snapshot count check → count 2
  const mock = async (fn) =>
    fn(
      makeQuerySeq(
        // 1. FOR UPDATE proposal fetch
        {
          rows: [{ id: 42, provider_market_id_a: 1, provider_market_id_b: 2, confidence: "0.9500", reasons: {} }],
          rowCount: 1,
        },
        // 2. market fetch
        {
          rows: [
            { id: 1, provider_id: 1, code: "kalshi", provider_market_ref: "PRES-2028-A", event_ref: "pres-2028" },
            { id: 2, provider_id: 2, code: "polymarket", provider_market_ref: "pres-2028#Biden", event_ref: "pres-2028" },
          ],
          rowCount: 2,
        },
        // 3. family label lookup → not found
        { rows: [], rowCount: 0 },
        // 4. canonical event lookup → not found
        { rows: [], rowCount: 0 },
        // 5. INSERT family
        { rows: [{ id: 10 }], rowCount: 1 },
        // 6. next_linker_run_version
        { rows: [{ next_version: 1 }], rowCount: 1 },
        // 7. insert_linker_run
        { rows: [{ id: 1, version: 1 }], rowCount: 1 },
        // 8. insert_market_link A
        { rows: [{ id: 100, family_id: 10, link_version: 1, status: "active" }], rowCount: 1 },
        // 9. insert_market_link B
        { rows: [{ id: 101, family_id: 10, link_version: 1, status: "active" }], rowCount: 1 },
        // 10. UPDATE proposed_links
        { rows: [], rowCount: 1 },
        // 11. INSERT review_decisions
        { rows: [], rowCount: 1 },
        // 12. snapshot count
        { rows: [{ count: 2 }], rowCount: 1 },
      ),
    );

  const app = await buildApp(mock);
  const res = await postDecision(app, {
    proposed_id: 42,
    decision: "accept",
    relationship_type: "equivalent",
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.decision, "accepted");
  assert.equal(body.family_id, 10);
  assert.equal(body.link_version, 1);
  assert.equal(body.divergence_available, true);
});

test("POST /v1/review/decision accept: partial failure prevents any writes (atomicity)", async () => {
  // Simulate DB error after family INSERT but before market_link INSERT.
  // withTransaction must roll back — no partial state committed.
  let callCount = 0;
  const writesAfterFailure = [];

  const mock = async (fn) => {
    // Real BEGIN/COMMIT/ROLLBACK tracking via fake pool
    const fakeClient = {
      query: async (sql) => {
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [], rowCount: 0 };
        if (sql === "ROLLBACK") return { rows: [], rowCount: 0 };
        callCount++;
        if (callCount === 5) {
          // Fail on insert_market_link (call #5 inside transaction)
          throw new Error("duplicate key value violates unique constraint ux_pmci_market_links_identity");
        }
        if (callCount > 5) {
          writesAfterFailure.push(sql.trim().slice(0, 40));
        }
        // Return plausible rows for each step
        const defaults = [
          null,
          { rows: [{ id: 42, provider_market_id_a: 1, provider_market_id_b: 2, confidence: "0.95", reasons: {} }], rowCount: 1 },
          { rows: [{ id: 1, provider_id: 1, code: "kalshi", provider_market_ref: "K-1", event_ref: "ev" }, { id: 2, provider_id: 2, code: "polymarket", provider_market_ref: "P-1", event_ref: "ev" }], rowCount: 2 },
          { rows: [], rowCount: 0 },
          { rows: [], rowCount: 0 },
          { rows: [{ id: 10 }], rowCount: 1 },
          { rows: [{ next_version: 1 }], rowCount: 1 },
          { rows: [{ id: 1, version: 1 }], rowCount: 1 },
        ];
        return defaults[callCount] ?? { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    const fakePool = { connect: async () => fakeClient };
    // Use real withTransaction logic with fake pool
    return withTransaction(fn, { _pool: fakePool });
  };

  const app = await buildApp(mock);
  const res = await postDecision(app, {
    proposed_id: 42,
    decision: "accept",
    relationship_type: "equivalent",
  });

  // Route should return 500 (unhandled throw propagates as Fastify 500)
  assert.equal(res.statusCode, 500);
  // No writes should have been attempted after the failure point
  assert.equal(writesAfterFailure.length, 0, `unexpected writes after failure: ${writesAfterFailure}`);
});

// ─── review decision — reject/skip atomicity ──────────────────────────────────

test("POST /v1/review/decision reject: returns error when proposal already decided", async () => {
  const mock = async (fn) => fn(makeQuerySeq({ rows: [], rowCount: 0 }));
  const app = await buildApp(mock);

  const res = await postDecision(app, {
    proposed_id: 7,
    decision: "reject",
    relationship_type: "equivalent",
    note: "unrelated",
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.error, "proposal_not_found_or_already_decided");
});

test("POST /v1/review/decision reject: succeeds when proposal is undecided", async () => {
  const mock = async (fn) =>
    fn(
      makeQuerySeq(
        { rows: [{ id: 7 }], rowCount: 1 }, // FOR UPDATE
        { rows: [], rowCount: 1 },            // UPDATE proposed_links
        { rows: [], rowCount: 1 },            // INSERT review_decisions
      ),
    );
  const app = await buildApp(mock);

  const res = await postDecision(app, {
    proposed_id: 7,
    decision: "reject",
    relationship_type: "equivalent",
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.decision, "rejected");
});

// ─── resolve/link idempotency via ON CONFLICT DO UPDATE ───────────────────────

test("POST /v1/resolve/link: idempotent — returns link row even on conflict (DO UPDATE)", async () => {
  // Simulate a conflict: insert_market_link resolves via DO UPDATE and still returns the row
  const mock = async (fn) =>
    fn(
      makeQuerySeq(
        { rows: [{ id: 1 }], rowCount: 1 },                                           // providers lookup
        { rows: [{ next_version: 3 }], rowCount: 1 },                                  // next_linker_run_version
        { rows: [{ id: 5, version: 3 }], rowCount: 1 },                                // insert_linker_run
        { rows: [{ id: 77, family_id: 1, link_version: 3, status: "active" }], rowCount: 1 }, // insert_market_link (DO UPDATE path)
      ),
    );

  const app = await buildApp(mock);
  const res = await postResolve(app, {
    family_id: 1,
    provider_code: "kalshi",
    provider_market_id: 999,
    relationship_type: "equivalent",
    confidence: 0.9,
    reasons: { source: "manual" },
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.link_id, 77);
  assert.equal(body.link_version, 3);
  assert.equal(body.status, "active");
});

test("POST /v1/resolve/link: returns unknown_provider when provider not found", async () => {
  const mock = async (fn) => fn(makeQuerySeq({ rows: [], rowCount: 0 }));
  const app = await buildApp(mock);

  const res = await postResolve(app, {
    family_id: 1,
    provider_code: "kalshi",
    provider_market_id: 999,
    relationship_type: "equivalent",
    confidence: 0.9,
    reasons: {},
  });

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).error, "unknown_provider");
});
