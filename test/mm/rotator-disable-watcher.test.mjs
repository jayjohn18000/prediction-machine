import test from "node:test";
import assert from "node:assert/strict";
import { runRotatorDisableWatcher } from "../../scripts/mm/rotator-disable-watcher.mjs";

test("disable watcher flags reject storm and blocklists ticker", async () => {
  let insertArgs = null;
  const client = {
    query: async (sql, params) => {
      if (sql.includes("pm.close_time < now()")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("t1.orders_1h") && sql.includes("UPDATE pmci.mm_market_config")) {
        return {
          rows: [{ ticker: "BADTICK", orders_1h: 25, rejects_1h: 15 }],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO pmci.mm_ticker_blocklist") && params) {
        insertArgs = params;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM t24") && sql.includes("INSERT INTO pmci.mm_ticker_blocklist")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("mm_kill_switch_events")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const s = await runRotatorDisableWatcher({ client, logger: { info: () => {} } });
  assert.equal(s.ok, true);
  assert.equal(s.reject_storm_disabled, 1);
  assert.equal(s.blocklist_1h_rows, 1);
  assert.ok(insertArgs);
  assert.equal(insertArgs[0], "BADTICK");
  assert.equal(insertArgs[1], 15);
});

test("disable watcher all quiet → zeros", async () => {
  const client = {
    query: async () => ({ rows: [], rowCount: 0 }),
  };
  const s = await runRotatorDisableWatcher({ client, logger: { info: () => {} } });
  assert.equal(s.ok, true);
  assert.equal(
    s.closed_disabled +
      s.reject_storm_disabled +
      s.kill_switch_disabled +
      s.blocklist_1h_rows +
      s.blocklist_24h_rows +
      s.adverse_selection_disabled +
      s.blocklist_adverse_rows,
    0,
  );
});

test("disable watcher flags adverse selection and disables market", async () => {
  let adverseNotes = null;
  const client = {
    query: async (sql, params) => {
      if (sql.includes("pm.close_time < now()")) return { rows: [], rowCount: 0 };
      if (sql.includes("t1.orders_1h") && sql.includes("UPDATE pmci.mm_market_config")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM t24") && sql.includes("INSERT INTO pmci.mm_ticker_blocklist")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("mm_kill_switch_events")) return { rows: [], rowCount: 0 };
      if (sql.includes("avg(f.adverse_cents_5m)") && sql.includes("SELECT market_id")) {
        return {
          rows: [{ market_id: 42, ticker: "TOXIC", fills_1h: 12, avg_adv_1h: -2.0 }],
          rowCount: 1,
        };
      }
      if (sql.includes("high_adverse_selection") && sql.includes("INSERT INTO pmci.mm_ticker_blocklist")) {
        adverseNotes = params?.[1] ?? null;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("market_id = ANY") && sql.includes("mm_market_config")) {
        return { rows: [{ market_id: 42 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const s = await runRotatorDisableWatcher({ client, logger: { info: () => {} } });
  assert.equal(s.ok, true);
  assert.equal(s.adverse_selection_disabled, 1);
  assert.equal(s.blocklist_adverse_rows, 1);
  assert.match(String(adverseNotes), /avg_adv=-2\.00c/);
  assert.match(String(adverseNotes), /12 fills/);
});
