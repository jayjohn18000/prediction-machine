/** @typedef {import('pg').Client | import('pg').PoolClient} PgConn */

async function safeQuery(client, sql, params = []) {
  try {
    return await client.query(sql, params);
  } catch {
    return { rows: [] };
  }
}

/**
 * Assumes unified view exposes hypothesis_id plus optional correctness / numeric fields.
 * @param {PgConn} client
 */
export async function loadUnifiedSignals(client) {
  const r = await safeQuery(
    client,
    `SELECT hypothesis_id::text AS hypothesis_id,
            signal_type::text AS signal_type,
            score::float8 AS score,
            observed_at,
            payload
     FROM pmci.scanner_signals_unified
     ORDER BY observed_at DESC NULLS LAST
     LIMIT 2000`,
  );
  return r.rows ?? [];
}

/**
 * Aggregate simple hit-rate per hypothesis when payload has `{ "correct": true|false }`
 * or column `correct` exists (fallback only).
 * @param {PgConn} client
 */
export async function loadHypothesisHitRates(client) {
  const r = await safeQuery(
    client,
    `
    WITH parsed AS (
      SELECT hypothesis_id::text AS hypothesis_id,
             CASE
               WHEN payload ? 'correct' THEN (payload->>'correct')::boolean
               WHEN payload ? 'hit' THEN (payload->>'hit')::boolean
               ELSE NULL
             END AS correct
      FROM pmci.scanner_signals_unified
      WHERE hypothesis_id IS NOT NULL
        AND observed_at > now() - interval '45 days'
    )
    SELECT hypothesis_id,
           count(*) FILTER (WHERE correct IS NOT NULL)::int AS n_labeled,
           count(*) FILTER (WHERE correct IS TRUE)::int AS hits
    FROM parsed
    GROUP BY hypothesis_id
    HAVING count(*) FILTER (WHERE correct IS NOT NULL) >= 5
    ORDER BY CASE WHEN count(*) FILTER (WHERE correct IS NOT NULL) >= 5
                  THEN count(*) FILTER (WHERE correct IS TRUE)::float /
                       count(*) FILTER (WHERE correct IS NOT NULL)::float ELSE 0 END DESC
    LIMIT 200`,
  );
  return r.rows ?? [];
}

/** @param {PgConn} client */
export async function loadHypothesesSummary(client) {
  const r = await safeQuery(
    client,
    `SELECT id::text AS id,
            status::text AS status,
            created_at,
            retired_at,
            retired_reason
     FROM pmci.hypotheses
     ORDER BY created_at DESC NULLS LAST
     LIMIT 500`,
  );
  return r.rows ?? [];
}

/** Allocation summary by hypothesis status counts. */
export async function loadCapitalSummary(client) {
  const r = await safeQuery(
    client,
    `SELECT status::text AS status,
            count(*)::int AS hypotheses
     FROM pmci.hypotheses
     GROUP BY status
     ORDER BY status`,
  );
  return r.rows ?? [];
}

/** @param {PgConn} client */
export async function loadDecayState(client) {
  const r = await safeQuery(
    client,
    `SELECT hypothesis_id::text AS hypothesis_id, triggers_retire::boolean AS triggers_retire,
            row_to_json(t.*)::jsonb AS snapshot
     FROM pmci.hypothesis_decay_state t
     ORDER BY hypothesis_id`,
  );
  return r.rows ?? [];
}

/** @param {PgConn} client */
export async function loadCrossDayPatterns(client) {
  return (
    (
      await safeQuery(
        client,
        `
        SELECT date_trunc('day', observed_at AT TIME ZONE 'UTC')::date AS day_utc,
               count(*)::int AS signal_count,
               count(DISTINCT hypothesis_id)::int AS hypotheses_touched
        FROM pmci.scanner_signals_unified
        WHERE observed_at > now() - interval '14 days'
        GROUP BY 1
        ORDER BY 1 DESC
        `,
      )
    ).rows ?? []
  );
}
