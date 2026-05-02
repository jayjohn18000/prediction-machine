import test from "node:test";
import assert from "node:assert/strict";
import { backfillPostFillMids } from "../../lib/mm/post-fill-backfill.mjs";

test("5m: one fill updates with depth, sibling fill skips depth_missing", async () => {
  const now = new Date("2026-05-02T12:00:00.000Z");
  const observedAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const rowWithDepth = {
    id: 1,
    market_id: 100,
    observed_at: observedAt,
    fair_value_at_fill: 50,
    side: "yes_buy",
    post_fill_mid_1m: 50,
    post_fill_mid_5m: null,
    post_fill_mid_30m: null,
  };
  const rowNoDepth = {
    id: 2,
    market_id: 101,
    observed_at: observedAt,
    fair_value_at_fill: 50,
    side: "yes_buy",
    post_fill_mid_1m: 50,
    post_fill_mid_5m: null,
    post_fill_mid_30m: null,
  };

  const client = {
    async query(sql, params) {
      const q = String(sql);
      if (q.includes("FROM pmci.mm_fills") && q.includes("LIMIT 5000")) {
        return { rows: [rowWithDepth, rowNoDepth] };
      }
      if (q.includes("FROM pmci.provider_market_depth")) {
        const mid = Number(params[0]) === 100 ? [{ mid_cents: "52" }] : [];
        return { rows: mid };
      }
      if (q.startsWith("UPDATE pmci.mm_fills")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    },
  };

  const stats = await backfillPostFillMids({ client, now });
  assert.equal(stats.updated5m, 1);
  assert.equal(stats.skipped5m, 1);
  assert.equal(stats.skipReasons.depth_missing, 1);
});

test("mock row younger than 1m horizon yields too_young skips", async () => {
  const now = new Date("2026-05-02T12:00:00.000Z");
  const row = {
    id: 3,
    market_id: 200,
    observed_at: new Date(now.getTime() - 30 * 1000).toISOString(),
    fair_value_at_fill: 50,
    side: "yes_buy",
    post_fill_mid_1m: null,
    post_fill_mid_5m: null,
    post_fill_mid_30m: null,
  };

  const client = {
    async query(sql) {
      const q = String(sql);
      if (q.includes("FROM pmci.mm_fills") && q.includes("LIMIT 5000")) {
        return { rows: [row] };
      }
      return { rows: [] };
    },
  };

  const stats = await backfillPostFillMids({ client, now });
  assert.equal(stats.skipped1m, 1);
  assert.ok(stats.skipReasons.too_young >= 1);
});

test("5m already_present increments skipReasons.already_present", async () => {
  const now = new Date("2026-05-02T12:00:00.000Z");
  const observedAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const row = {
    id: 4,
    market_id: 300,
    observed_at: observedAt,
    fair_value_at_fill: 50,
    side: "yes_buy",
    post_fill_mid_1m: 49,
    post_fill_mid_5m: 55,
    post_fill_mid_30m: null,
  };

  const client = {
    async query(sql) {
      const q = String(sql);
      if (q.includes("FROM pmci.mm_fills") && q.includes("LIMIT 5000")) {
        return { rows: [row] };
      }
      return { rows: [] };
    },
  };

  const stats = await backfillPostFillMids({ client, now });
  assert.equal(stats.skipped5m, 1);
  assert.ok(stats.skipReasons.already_present >= 1);
});

test("regression: updated5m still increments on successful 5m backfill", async () => {
  const now = new Date("2026-05-02T12:00:00.000Z");
  const observedAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const row = {
    id: 5,
    market_id: 400,
    observed_at: observedAt,
    fair_value_at_fill: 50,
    side: "yes_buy",
    post_fill_mid_1m: 50,
    post_fill_mid_5m: null,
    post_fill_mid_30m: null,
  };

  const client = {
    async query(sql) {
      const q = String(sql);
      if (q.includes("FROM pmci.mm_fills") && q.includes("LIMIT 5000")) {
        return { rows: [row] };
      }
      if (q.includes("FROM pmci.provider_market_depth")) {
        return { rows: [{ mid_cents: "53" }] };
      }
      if (q.startsWith("UPDATE pmci.mm_fills")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    },
  };

  const stats = await backfillPostFillMids({ client, now });
  assert.equal(stats.updated5m, 1);
});
