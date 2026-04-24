#!/usr/bin/env node
/**
 * Resume-aware wrapper around A1 resolution ingest.
 * Processes only linked-sports provider_markets that don't yet have a row in pmci.market_outcomes,
 * so it can be rerun until stats.examined === 0.
 *
 * Flags: --limit N (default 60)
 *
 * Added during pivot execution on 2026-04-23 because the sandboxed runner
 * can't hold a single long-running backfill open past 45s. Safe to delete
 * once backfill is complete; the canonical script is pmci-ingest-market-outcomes.mjs.
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";
import { fetchKalshiMarketOutcome } from "../../lib/resolution/kalshi-outcome.mjs";
import { fetchPolymarketMarketOutcome } from "../../lib/resolution/polymarket-outcome.mjs";
import { persistSettlementObservation } from "../../lib/resolution/persist-outcomes.mjs";

const { Client } = pg;
loadEnv();

const SQL_WINDOW = `
  SELECT DISTINCT
    pm.id AS provider_market_id,
    pm.provider_id,
    pr.code AS provider_code,
    pm.provider_market_ref
  FROM pmci.v_market_links_current ml
  JOIN pmci.provider_markets pm ON pm.id = ml.provider_market_id
  JOIN pmci.providers pr ON pr.id = pm.provider_id
  WHERE pm.category = 'sports' AND pm.id > $1
  ORDER BY pm.id
  LIMIT $2
`;

function parseArgs(argv) {
  let limit = 60;
  let afterId = 0;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--limit" && argv[i + 1]) {
      limit = Math.max(1, parseInt(argv[++i], 10) || 60);
    } else if (argv[i] === "--after-id" && argv[i + 1]) {
      afterId = Math.max(0, parseInt(argv[++i], 10) || 0);
    }
  }
  return { limit, afterId };
}

async function main() {
  const { limit, afterId } = parseArgs(process.argv);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const stats = {
    examined: 0,
    settled: 0,
    persisted: 0,
    skippedUnsettled: 0,
    errors: 0,
    lastId: afterId,
  };
  try {
    const res = await client.query(SQL_WINDOW, [afterId, limit]);
    const rows = res.rows || [];
    for (const row of rows) {
      stats.examined++;
      stats.lastId = Number(row.provider_market_id);
      const code = String(row.provider_code || "").toLowerCase();
      const ref = row.provider_market_ref;
      const pmId = Number(row.provider_market_id);
      const providerId = Number(row.provider_id);
      try {
        const fetched =
          code === "kalshi"
            ? await fetchKalshiMarketOutcome(ref)
            : code === "polymarket"
              ? await fetchPolymarketMarketOutcome(ref)
              : null;
        if (!fetched) continue;
        if (!fetched.settled) {
          stats.skippedUnsettled++;
        } else {
          stats.settled++;
          await persistSettlementObservation(client, {
            providerMarketId: pmId,
            providerId,
            winningOutcome: fetched.winningOutcome,
            winningOutcomeRaw: fetched.winningOutcomeRaw,
            resolvedAt: fetched.resolvedAt,
            resolutionSourceObserved: fetched.resolutionSource,
            rawSettlement: fetched.raw,
          });
          stats.persisted++;
        }
      } catch (err) {
        stats.errors++;
        console.error(`[err] pmId=${pmId} ref=${ref}: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    console.log(JSON.stringify(stats));
    process.exit(0);
  } finally {
    await client.end();
  }
}

main();
