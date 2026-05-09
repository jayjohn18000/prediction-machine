/**
 * Track A — daily Whelan-band aggregate into pmci.scanner_structural_signals.
 * SQL follows docs/scanner/scanner-plan-v1.md §5.2 with Stream B guards on mm_fills.
 */

/**
 * @param {import("pg").Client | import("pg").PoolClient} client
 * @returns {Promise<{ inserted: number }>}
 */
export async function runWhelanStructuralAggregate(client) {
  const result = await client.query(`
    INSERT INTO pmci.scanner_structural_signals (
      signal_id, observed_at, market_ticker, signal_strength_cents,
      source_chain_id, detector_track, price_band, side, trade_count,
      realized_yield_pct, band_window_start, band_window_end
    )
    SELECT gen_random_uuid(), now(), 'AGGREGATE',
           avg(yield_cents),
           (SELECT id FROM pmci.source_chains WHERE detection ILIKE 'whelan%' ORDER BY first_seen LIMIT 1),
           'whelan_band',
           price_band, side, count(*)::int, avg(realized_yield_pct)::numeric,
           date_trunc('day', now() AT TIME ZONE 'UTC') - interval '1 day',
           date_trunc('day', now() AT TIME ZONE 'UTC')
    FROM (
      SELECT
        CASE
          WHEN entry_price BETWEEN 0.50 AND 0.60 THEN '50-60c'
          WHEN entry_price BETWEEN 0.60 AND 0.70 THEN '60-70c'
          WHEN entry_price BETWEEN 0.70 AND 0.80 THEN '70-80c'
        END AS price_band,
        CASE WHEN was_maker THEN 'maker' ELSE 'taker' END AS side,
        (COALESCE(settled_value, 0) - entry_price) * 100 AS yield_cents,
        (COALESCE(settled_value, 0) - entry_price) / NULLIF(entry_price, 0) AS realized_yield_pct
      FROM pmci.mm_fills
      WHERE observed_at >= date_trunc('day', now() AT TIME ZONE 'UTC') - interval '1 day'
        AND observed_at < date_trunc('day', now() AT TIME ZONE 'UTC')
        AND was_maker IS NOT NULL
        AND settlement_outcome IS NOT NULL
        AND settlement_outcome <> 'no_settle'
        AND settled_value IS NOT NULL
    ) t
    WHERE price_band IS NOT NULL
    GROUP BY price_band, side
  `);
  return { inserted: result.rowCount ?? 0 };
}
