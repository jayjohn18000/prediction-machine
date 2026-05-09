import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

test("rodlaf bug 6: per_trade × max_concurrent_positions ≤ total_capital × 0.5", async () => {
  const totalCap = Number(process.env.MM_EQUITY_BASE_CENTS ?? 500_000);
  let perTradeNotional = 500;
  let concurrent = 10;

  const cs = process.env.DATABASE_URL?.trim();
  if (cs) {
    const c = new pg.Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
    await c.connect();
    try {
      const r = await c.query(`
        SELECT
          COALESCE(MAX(base_size_contracts), 1)::numeric AS base_sz,
          COALESCE(MAX(max_order_notional_cents), 500)::int AS max_nom,
          COUNT(*) FILTER (WHERE enabled = true)::int AS n_enabled
        FROM pmci.mm_market_config
      `);
      const row = r.rows[0] ?? {};
      concurrent = Math.max(1, Number(row.n_enabled) || 1);
      const baseSz = Number(row.base_sz) || 1;
      const maxNom = Number(row.max_nom) || 500;
      perTradeNotional = Math.min(maxNom, baseSz * 99);
    } finally {
      await c.end().catch(() => {});
    }
  } else {
    concurrent = Number(process.env.MM_ROTATOR_TARGET_COUNT ?? 10);
    perTradeNotional = 500;
  }

  const lhs = perTradeNotional * concurrent;
  const rhs = totalCap * 0.5;
  assert.ok(lhs <= rhs + 1, `risk cap: ${lhs}c notional worst-case vs 50% of ${totalCap}c = ${rhs}c`);
});
