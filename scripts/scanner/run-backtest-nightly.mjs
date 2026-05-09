#!/usr/bin/env node
/**
 * Nightly scanner backtest job — placeholders until Stream E engine is wired.
 * Exit 0: marker run (no hypotheses or stubbed).
 */
import process from "node:process";
import { createPgClient } from "../../lib/mm/order-store.mjs";
import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

const client = createPgClient();
await client.connect();
try {
  const { rows } = await client.query(
    `SELECT id::text FROM pmci.hypotheses WHERE status::text IN ('live','testing') LIMIT 50`,
  );
  if (!rows.length) {
    console.log(JSON.stringify({ ok: true, note: "no live/testing hypotheses — idle" }));
    process.exit(0);
  }
  if (process.env.PMCI_SCANNER_BACKTEST_STRICT === "1") {
    console.error(
      "PMCI_SCANNER_BACKTEST_STRICT=1 requires Stream E; exiting 12.",
    );
    process.exit(12);
  }
  console.log(
    JSON.stringify({
      ok: true,
      stub: true,
      count_candidates: rows.length,
      ids: rows.map((r) => r.id),
    }),
  );
} catch (e) {
  console.error(/** @type {Error} */ (e).message);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
