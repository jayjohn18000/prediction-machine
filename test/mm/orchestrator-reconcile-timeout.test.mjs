import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { runMmOrchestratorLoop } from "../../lib/mm/orchestrator.mjs";

function ephemeralPk() {
  const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return kp.privateKey;
}

test("outer reconcile timeout still allows main loop to tick", async () => {
  /** @type {Record<string, unknown>} */
  const health = {};
  const privateKey = ephemeralPk();
  const pgClient = {
    /**
     * @param {string} sql
     */
    async query(sql, params = []) {
      if (/UPDATE pmci.mm_orders AS o/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], sql, params };
    },
    async connect() {},
    async end() {},
  };

  const t0 = Date.now();
  await runMmOrchestratorLoop({
    health,
    pgClient: /** @type {any} */ (pgClient),
    markets: [
      {
        kalshi_ticker: "KX-T",
        market_id: 1,
        kill_switch_active: false,
        stale_quote_timeout_seconds: 600,
        min_requote_cents: 1,
      },
    ],
    portfolioDailyPnLCentsCached: 0,
    tradeBaseUrl: "https://demo-api.kalshi.co/trade-api/v2",
    keyId: "test-key-id",
    privateKey,
    durationMs: 12_000,
    intervalMs: 2500,
    reconcileOuterTimeoutMs: 150,
    reconcileImpl: () => new Promise(() => {}),
    runSessionImpl: async () => ["stub_session"],
  });
  assert.ok(Number(health.loopTick) >= 1);
  assert.equal(health.lastReconcileTimedOut, true);
  assert.ok(Date.now() - t0 < 20_000);
});
