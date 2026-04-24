/**
 * Write settlement rows: append history, upsert current (single transaction).
 */

const SQL_HISTORY = `
  INSERT INTO pmci.market_outcome_history (
    provider_market_id,
    provider_id,
    winning_outcome,
    winning_outcome_raw,
    resolved_at,
    resolution_source_observed,
    raw_settlement
  ) VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6, $7::jsonb)
`;

const SQL_UPSERT_CURRENT = `
  INSERT INTO pmci.market_outcomes (
    provider_market_id,
    provider_id,
    winning_outcome,
    winning_outcome_raw,
    resolved_at,
    resolution_source_observed,
    raw_settlement
  ) VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6, $7::jsonb)
  ON CONFLICT (provider_market_id) DO UPDATE SET
    provider_id = EXCLUDED.provider_id,
    winning_outcome = EXCLUDED.winning_outcome,
    winning_outcome_raw = EXCLUDED.winning_outcome_raw,
    resolved_at = EXCLUDED.resolved_at,
    resolution_source_observed = EXCLUDED.resolution_source_observed,
    raw_settlement = EXCLUDED.raw_settlement
`;

function jsonParam(v) {
  if (v == null) return null;
  return JSON.stringify(v);
}

/**
 * @param {import('pg').Client} client
 * @param {object} row
 * @param {number} row.providerMarketId
 * @param {number} row.providerId
 * @param {string} row.winningOutcome
 * @param {object|null} [row.winningOutcomeRaw]
 * @param {string|null} [row.resolvedAt] - ISO string or null
 * @param {string} row.resolutionSourceObserved
 * @param {object} row.rawSettlement
 */
export async function persistSettlementObservation(client, row) {
  const {
    providerMarketId,
    providerId,
    winningOutcome,
    winningOutcomeRaw = null,
    resolvedAt = null,
    resolutionSourceObserved,
    rawSettlement,
  } = row;

  const vals = [
    providerMarketId,
    providerId,
    winningOutcome,
    jsonParam(winningOutcomeRaw),
    resolvedAt,
    resolutionSourceObserved,
    jsonParam(rawSettlement ?? {}),
  ];

  await client.query("BEGIN");
  try {
    await client.query(SQL_HISTORY, vals);
    await client.query(SQL_UPSERT_CURRENT, vals);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}
