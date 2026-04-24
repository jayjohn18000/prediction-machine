/**
 * Resolution ingestion (A1): linked sports provider_markets → Kalshi / Polymarket settlement APIs.
 */
import { fetchKalshiMarketOutcome } from "./kalshi-outcome.mjs";
import { fetchPolymarketMarketOutcome } from "./polymarket-outcome.mjs";
import { getProviderIds } from "../pmci-ingestion.mjs";
import { persistSettlementObservation } from "./persist-outcomes.mjs";

const SQL_LINKED_SPORTS_MARKETS = `
  SELECT DISTINCT
    pm.id AS provider_market_id,
    pm.provider_id,
    pr.code AS provider_code,
    pm.provider_market_ref
  FROM pmci.v_market_links_current ml
  JOIN pmci.provider_markets pm ON pm.id = ml.provider_market_id
  JOIN pmci.providers pr ON pr.id = pm.provider_id
  WHERE pm.category = 'sports'
  ORDER BY pm.id
`;

/**
 * @param {import('pg').Client} client
 * @param {object} [options]
 * @param {number|null} [options.limit] - max markets to process
 * @param {boolean} [options.dryRun] - fetch only, no DB writes
 * @param {number} [options.delayMs] - pause between HTTP calls
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<{ examined: number, settled: number, persisted: number, skippedUnsettled: number, errors: number }>}
 */
export async function runMarketOutcomeIngest(client, options = {}) {
  const {
    limit = null,
    dryRun = false,
    delayMs = 75,
    log = console.log,
  } = options;

  const ids = await getProviderIds(client);
  if (!ids) {
    throw new Error("pmci.providers must include kalshi and polymarket");
  }

  const res = await client.query(SQL_LINKED_SPORTS_MARKETS);
  let rows = res.rows || [];
  if (typeof limit === "number" && limit > 0) {
    rows = rows.slice(0, limit);
  }

  const stats = {
    examined: 0,
    settled: 0,
    persisted: 0,
    skippedUnsettled: 0,
    errors: 0,
  };

  for (const row of rows) {
    stats.examined++;
    const providerCode = String(row.provider_code || "").toLowerCase();
    const ref = row.provider_market_ref;
    const pmId = Number(row.provider_market_id);
    const providerId = Number(row.provider_id);

    try {
      let fetched;
      if (providerCode === "kalshi") {
        fetched = await fetchKalshiMarketOutcome(ref);
      } else if (providerCode === "polymarket") {
        fetched = await fetchPolymarketMarketOutcome(ref);
      } else {
        log(`[outcomes] skip unknown provider ${providerCode} market_id=${pmId}`);
        continue;
      }

      if (!fetched.settled) {
        stats.skippedUnsettled++;
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        continue;
      }

      stats.settled++;
      if (dryRun) {
        log(
          `[outcomes] dry-run settled market_id=${pmId} ${providerCode} winner=${fetched.winningOutcome}`,
        );
      } else {
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
      log(`[outcomes] error market_id=${pmId} ref=${ref}: ${err.message}`);
    }

    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return stats;
}
