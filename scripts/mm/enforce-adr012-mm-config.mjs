#!/usr/bin/env node
/**
 * Disable any pmci.mm_market_config row whose Kalshi ticker is not in the ADR-012
 * seven-market PROD allowlist. Idempotent — safe to re-run after rotator drifts.
 *
 * Env: DATABASE_URL (service role).
 *
 * Does not DELETE rows (preserves history); sets enabled = false only.
 */

import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

/** @type {readonly string[]} ADR-012 PROD universe */
export const ADR012_PROD_TICKERS = Object.freeze([
  "KXNBA-26-OKC",
  "CONTROLS-2026-D",
  "KXMIDTERMMOV-MAGOVD-P26",
  "KXWTIMAX-26DEC31-T135",
  "GOVPARTYAZ-26-D",
  "KXETHMINY-27JAN01-1250",
  "KXLCPIMAXYOY-27-P4.5",
]);

async function main() {
  const cs = process.env.DATABASE_URL?.trim();
  if (!cs) throw new Error("DATABASE_URL required");
  const client = new pg.Client({
    connectionString: cs,
    ssl: cs.includes("supabase.co") || cs.includes("amazonaws") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    const upd = await client.query(
      `
      UPDATE pmci.mm_market_config c
      SET enabled = false
      FROM pmci.provider_markets pm
      WHERE pm.id = c.market_id
        AND pm.provider_market_ref NOT IN (SELECT unnest($1::text[]))
        AND c.enabled = true
      `,
      [Array.from(ADR012_PROD_TICKERS)],
    );
    const cnt = await client.query(
      `SELECT count(*)::int AS n FROM pmci.mm_market_config WHERE enabled = true`,
    );
    const n = cnt.rows[0]?.n ?? -1;
    console.log(
      JSON.stringify(
        {
          disabled_non_allowlist_rows: upd.rowCount,
          enabled_count: n,
          allowlist_ok: n === ADR012_PROD_TICKERS.length,
        },
        null,
        2,
      ),
    );
    if (n !== ADR012_PROD_TICKERS.length) {
      console.error(
        `[enforce-adr012-mm-config] expected enabled_count=${ADR012_PROD_TICKERS.length}, got ${n} — check provider_markets seeding`,
      );
      process.exitCode = 2;
    }
  } finally {
    await client.end();
  }
}

await main();
