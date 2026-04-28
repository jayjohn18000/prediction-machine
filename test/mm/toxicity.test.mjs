import test from "node:test";
import assert from "node:assert/strict";
import { computeToxicityScore, evaluateKillSwitchCondition } from "../../lib/mm/toxicity.mjs";

function stubTrader() {
  return {
    getOrders: async () => ({ orders: [] }),
    cancelOrder: async () => {},
  };
}

/** @returns {import('pg').Client | any} */
function makeClient(handler) {
  return { query: handler };
}

test("computeToxicityScore: high mean adverse yields higher score than mixed book", async () => {
  const hostile = await computeToxicityScore({
    client: makeClient(async (sql) => {
      if (String(sql).includes("FROM pmci.mm_fills")) {
        return { rows: [{ adverse_cents_5m: "20" }, { adverse_cents_5m: "20" }] };
      }
      return { rows: [] };
    }),
    marketId: 1,
  });

  const mixed = await computeToxicityScore({
    client: makeClient(async (sql) => {
      if (String(sql).includes("FROM pmci.mm_fills")) {
        return { rows: [{ adverse_cents_5m: "1" }, { adverse_cents_5m: "-1" }] };
      }
      return { rows: [] };
    }),
    marketId: 1,
  });

  assert.ok(hostile.mean_adverse > mixed.mean_adverse);
  assert.ok(hostile.score > mixed.score);
});

test("computeToxicityScore: few fills → lower score than many at same mean", async () => {
  const one = await computeToxicityScore({
    client: makeClient(async (sql) => {
      if (String(sql).includes("FROM pmci.mm_fills")) {
        return { rows: [{ adverse_cents_5m: "10" }] };
      }
      return { rows: [] };
    }),
    marketId: 1,
  });

  const many = await computeToxicityScore({
    client: makeClient(async (sql) => {
      if (String(sql).includes("FROM pmci.mm_fills")) {
        const rows = [];
        for (let i = 0; i < 100; i += 1) rows.push({ adverse_cents_5m: "10" });
        return { rows };
      }
      return { rows: [] };
    }),
    marketId: 1,
  });

  assert.ok(many.score > one.score);
});

test("evaluateKillSwitchCondition: trips toxicity_threshold", async () => {
  const calls = [];
  const client = makeClient(async (sql) => {
    const s = String(sql);
    calls.push(s.slice(0, 80));
    if (s.includes("FROM pmci.mm_fills") && s.includes("consecutive") === false && s.includes("ORDER BY") === false) {
      return { rows: Array(10).fill(null).map(() => ({ adverse_cents_5m: "50" })) };
    }
    if (s.includes("UPDATE pmci.mm_market_config") && s.includes("last_toxicity_score")) {
      return { rowCount: 1, rows: [] };
    }
    if (s.includes("INSERT INTO pmci.mm_kill_switch_events")) {
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("UPDATE pmci.mm_market_config") && s.includes("kill_switch_active = true")) {
      return { rowCount: 1, rows: [] };
    }
    return { rows: [] };
  });

  const r = await evaluateKillSwitchCondition({
    client,
    trader: stubTrader(),
    marketId: 99,
    ticker: "KXHOT",
    marketConfig: { kill_switch_active: false, toxicity_threshold: 1, daily_loss_limit_cents: 0 },
    currentDailyPnl: 0,
  });

  assert.equal(r.triggered, true);
  assert.equal(r.reason, "toxicity_threshold");
  assert.ok(calls.some((c) => c.includes("mm_kill_switch_events")));
});

test("evaluateKillSwitchCondition: trips daily_loss", async () => {
  const client = makeClient(async (sql) => {
    const s = String(sql);
    if (s.includes("FROM pmci.mm_fills") && !s.includes("ORDER BY observed_at DESC")) {
      return { rows: [{ adverse_cents_5m: "0" }] };
    }
    if (s.includes("UPDATE pmci.mm_market_config") && s.includes("last_toxicity_score")) {
      return { rowCount: 1, rows: [] };
    }
    if (s.includes("INSERT INTO pmci.mm_kill_switch_events")) {
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("UPDATE pmci.mm_market_config") && s.includes("kill_switch_active = true")) {
      return { rowCount: 1, rows: [] };
    }
    return { rows: [] };
  });

  const r = await evaluateKillSwitchCondition({
    client,
    trader: stubTrader(),
    marketId: 1,
    ticker: "KX",
    marketConfig: { kill_switch_active: false, toxicity_threshold: 999_999, daily_loss_limit_cents: 100 },
    currentDailyPnl: -500,
  });

  assert.equal(r.triggered, true);
  assert.equal(r.reason, "daily_loss");
});

test("evaluateKillSwitchCondition: consecutive adverse fills (last 5 all > 0)", async () => {
  const client = makeClient(async (sql) => {
    const s = String(sql);
    if (s.includes("FROM pmci.mm_fills") && s.includes("ORDER BY observed_at DESC")) {
      return {
        rows: [
          { adverse_cents_5m: "2" },
          { adverse_cents_5m: "2" },
          { adverse_cents_5m: "2" },
          { adverse_cents_5m: "2" },
          { adverse_cents_5m: "2" },
        ],
      };
    }
    if (s.includes("FROM pmci.mm_fills") && s.includes("adverse_cents_5m IS NOT NULL")) {
      return { rows: [{ adverse_cents_5m: "1" }] };
    }
    if (s.includes("UPDATE pmci.mm_market_config") && s.includes("last_toxicity_score")) {
      return { rowCount: 1, rows: [] };
    }
    if (s.includes("INSERT INTO pmci.mm_kill_switch_events")) {
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("UPDATE pmci.mm_market_config") && s.includes("kill_switch_active = true")) {
      return { rowCount: 1, rows: [] };
    }
    return { rows: [] };
  });

  const r = await evaluateKillSwitchCondition({
    client,
    trader: stubTrader(),
    marketId: 2,
    ticker: "KX",
    marketConfig: { kill_switch_active: false, toxicity_threshold: 999_999, daily_loss_limit_cents: 0 },
    currentDailyPnl: 0,
  });

  assert.equal(r.triggered, true);
  assert.equal(r.reason, "consecutive_adverse_fills");
});

test("evaluateKillSwitchCondition: skips when kill_switch already active", async () => {
  const r = await evaluateKillSwitchCondition({
    client: makeClient(async () => {
      throw new Error("should not query when already active");
    }),
    trader: stubTrader(),
    marketId: 3,
    ticker: "KX",
    marketConfig: { kill_switch_active: true, toxicity_threshold: 0, daily_loss_limit_cents: 0 },
    currentDailyPnl: 0,
  });
  assert.equal(r.skipped, "already_active");
});
