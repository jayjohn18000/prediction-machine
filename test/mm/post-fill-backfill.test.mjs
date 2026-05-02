import test from "node:test";
import assert from "node:assert/strict";
import {
  computeSideSign,
  findClosestMidInWindow,
  backfillPostFillMids,
} from "../../lib/mm/post-fill-backfill.mjs";

test("computeSideSign covers all four contract sides", () => {
  assert.equal(computeSideSign("yes_buy"), 1);
  assert.equal(computeSideSign("yes_sell"), -1);
  assert.equal(computeSideSign("no_buy"), -1);
  assert.equal(computeSideSign("no_sell"), 1);
});

test("findClosestMidInWindow picks nearest mid within ±10s", async () => {
  const client = {
    async query(sql) {
      assert.ok(String(sql).includes("provider_market_depth"));
      assert.ok(String(sql).includes("interval '10 seconds'"));
      return { rows: [{ mid_cents: "52.5" }] };
    },
  };
  const v = await findClosestMidInWindow(client, 99, new Date("2026-01-01T12:05:07Z"));
  assert.equal(v, 52.5);
});

test("findClosestMidInWindow yields null when depth empty", async () => {
  const client = {
    async query() {
      return { rows: [] };
    },
  };
  assert.equal(await findClosestMidInWindow(client, 1, new Date()), null);
});

test("backfill skips when depth gap leaves no mid — no adverse update", async () => {
  let touchedDepth = 0;

  const old = new Date();
  old.setUTCMinutes(old.getUTCMinutes() - 20);

  const fillRow = {
    id: 1,
    market_id: 42,
    observed_at: old.toISOString(),
    fair_value_at_fill: 50,
    side: "yes_buy",
    post_fill_mid_1m: null,
    post_fill_mid_5m: null,
    post_fill_mid_30m: null,
  };

  let sawUpdate = false;

  const client = {
    async query(sql) {
      const q = String(sql);
      if (q.includes("FROM pmci.mm_fills") && q.includes("post_fill_mid_30m")) {
        return { rows: [fillRow] };
      }
      if (q.includes("FROM pmci.provider_market_depth")) {
        touchedDepth += 1;
        return { rows: [] };
      }
      if (q.startsWith("UPDATE pmci.mm_fills")) {
        sawUpdate = true;
      }
      return { rows: [] };
    },
  };

  const now = new Date();
  const st = await backfillPostFillMids({ client, now });
  assert.equal(st.updated5m, 0);
  assert.equal(st.skipped5m, 1);
  assert.equal(st.skipReasons.depth_missing, 2);
  assert.ok(touchedDepth >= 1);
  assert.equal(sawUpdate, false);
});

test("5m backfill writes adverse_cents_5m = side_sign × (post_mid − fv) for each side", async () => {
  const fv = 50;
  const postMid = 55;

  for (const c of [
    { side: "yes_buy", expected: 5 },
    { side: "yes_sell", expected: -5 },
    { side: "no_sell", expected: 5 },
    { side: "no_buy", expected: -5 },
  ]) {
    const fillRow = {
      id: 100,
      market_id: 7,
      observed_at: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
      fair_value_at_fill: fv,
      side: c.side,
      post_fill_mid_1m: null,
      post_fill_mid_5m: null,
      post_fill_mid_30m: null,
    };

    const client = {
      async query(sql, params) {
        const q = String(sql);
        if (q.includes("FROM pmci.mm_fills") && q.includes("LIMIT 5000")) {
          return { rows: [{ ...fillRow }] };
        }
        if (q.includes("FROM pmci.provider_market_depth")) {
          return { rows: [{ mid_cents: String(postMid) }] };
        }
        if (q.startsWith("UPDATE pmci.mm_fills") && q.includes("post_fill_mid_5m")) {
          assert.equal(Number(params[2]), c.expected, `side ${c.side} adverse mismatch`);
          return { rows: [], rowCount: 1 };
        }
        if (q.startsWith("UPDATE pmci.mm_fills") && q.includes("post_fill_mid_1m")) {
          return { rows: [], rowCount: 1 };
        }
        if (q.startsWith("UPDATE pmci.mm_fills") && q.includes("post_fill_mid_30m")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
      },
    };

    const st = await backfillPostFillMids({ client, now: new Date() });
    assert.equal(st.updated5m, 1, `side ${c.side}`);
  }
});
