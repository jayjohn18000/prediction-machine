import {
  PAIR_FAILURE_WINDOW_MINUTES,
  buildByProviderDrilldown,
  buildTrueSuccessRateBlockFromAggregate,
} from "./pair-failure-alert.mjs";

/**
 * Observer heartbeat health: recent cycles + Σ pair KPIs over a sliding heartbeat window (truth tables).
 */

const WINDOW_AGG_SQL = `
  SELECT
    COALESCE(SUM(pairs_attempted), 0)::bigint AS pairs_attempted,
    COALESCE(SUM(pairs_succeeded), 0)::bigint AS pairs_succeeded,
    COALESCE(SUM(kalshi_fetch_errors), 0)::bigint AS sum_kalshi_fetch_errors,
    COALESCE(SUM(polymarket_fetch_errors), 0)::bigint AS sum_polymarket_fetch_errors,
    COALESCE(SUM(spread_insert_errors), 0)::bigint AS sum_spread_insert_errors,
    COUNT(*)::int AS heartbeat_cycles_in_window
  FROM pmci.observer_heartbeats
  WHERE cycle_at >= now() - ($1::int * interval '1 minute')
`;

export async function getObserverHealth(db, options = {}) {
  const maxLagSeconds = Number(options.maxLagSeconds ?? 120);
  const observerWindow = Number(options.observerWindow ?? 20);
  const providerFilter =
    typeof options.providerFilter === "string"
      ? String(options.providerFilter).toLowerCase()
      : null;

  const lastAgg = await db.query(`SELECT MAX(cycle_at) AS observer_last_run FROM pmci.observer_heartbeats`);
  const heartbeatResult = await db.query(
    `
      select cycle_at, pairs_attempted, pairs_succeeded, pairs_configured,
        kalshi_fetch_errors, polymarket_fetch_errors,
        spread_insert_errors, pmci_ingestion_errors, json_parse_errors
      from pmci.observer_heartbeats
      order by cycle_at desc
      limit $1
    `,
    [observerWindow],
  );
  const windowResult = await db.query(WINDOW_AGG_SQL, [PAIR_FAILURE_WINDOW_MINUTES]);

  const windowRowRaw = windowResult.rows?.[0] ?? {};

  /** @type {Awaited<ReturnType<typeof buildTrueSuccessRateBlockFromAggregate>> & { heartbeat_cycles_in_window?: number, by_provider?: object, provider_focus?: unknown }} */
  let true_success_rate_detail = buildTrueSuccessRateBlockFromAggregate(windowRowRaw);
  true_success_rate_detail = {
    ...true_success_rate_detail,
    heartbeat_cycles_in_window: Number(windowRowRaw.heartbeat_cycles_in_window ?? 0),
    by_provider: buildByProviderDrilldown({
      pairs_attempted: windowRowRaw.pairs_attempted,
      pairs_succeeded: windowRowRaw.pairs_succeeded,
      sum_kalshi_fetch_errors: windowRowRaw.sum_kalshi_fetch_errors,
      sum_polymarket_fetch_errors: windowRowRaw.sum_polymarket_fetch_errors,
      sum_spread_insert_errors: windowRowRaw.sum_spread_insert_errors,
    }),
  };

  let provider_focus = undefined;
  if (providerFilter === "kalshi" || providerFilter === "polymarket") {
    provider_focus =
      true_success_rate_detail.by_provider[
        providerFilter === "kalshi" ? "kalshi" : "polymarket"
      ];
  }

  const lastRun = lastAgg.rows[0]?.observer_last_run ?? null;
  const lastRunDate = lastRun ? new Date(lastRun) : null;
  const lagSeconds = lastRunDate
    ? Math.max(0, Math.round((Date.now() - lastRunDate.getTime()) / 1000))
    : null;

  const rows = heartbeatResult.rows ?? [];
  if (rows.length === 0) {
    return {
      status: "no_data",
      latest_cycle_at: lastRunDate ? lastRunDate.toISOString() : null,
      last_run: lastRunDate ? lastRunDate.toISOString() : null,
      lag_seconds: lagSeconds,
      healthy: lagSeconds !== null && lagSeconds <= maxLagSeconds,
      rolling_success_rate: null,
      configured_pair_success_rate: null,
      /** @type {typeof true_success_rate_detail} */
      true_success_rate: {
        ...true_success_rate_detail,
        pairs_attempted: 0,
        pairs_succeeded: 0,
        pairs_failed: 0,
        failure_rate: null,
        alert: false,
        alert_threshold: true_success_rate_detail.alert_threshold,
        alert_reason: null,
        heartbeat_cycles_in_window: 0,
        by_provider: {
          kalshi: {
            pairs_attempted: 0,
            pairs_succeeded: 0,
            pairs_failed: 0,
            failure_rate: null,
          },
          polymarket: {
            pairs_attempted: 0,
            pairs_succeeded: 0,
            pairs_failed: 0,
            failure_rate: null,
          },
        },
        provider_focus: provider_focus ?? null,
      },
      pairs_configured_total: 0,
      rolling_window_cycles: 0,
      error_totals: null,
    };
  }

  let totalAttempted = 0;
  let totalSucceeded = 0;
  let totalConfigured = 0;
  let trueNumerator = 0;
  const errorTotals = {
    kalshi_fetch_errors: 0,
    polymarket_fetch_errors: 0,
    spread_insert_errors: 0,
    pmci_ingestion_errors: 0,
    json_parse_errors: 0,
  };

  for (const row of rows) {
    const configured = Number(row.pairs_configured ?? 0);
    totalAttempted += Number(row.pairs_attempted ?? 0);
    totalSucceeded += Number(row.pairs_succeeded ?? 0);
    totalConfigured += configured;
    if (configured > 0) trueNumerator += Number(row.pairs_succeeded ?? 0);
    errorTotals.kalshi_fetch_errors += Number(row.kalshi_fetch_errors ?? 0);
    errorTotals.polymarket_fetch_errors += Number(row.polymarket_fetch_errors ?? 0);
    errorTotals.spread_insert_errors += Number(row.spread_insert_errors ?? 0);
    errorTotals.pmci_ingestion_errors += Number(row.pmci_ingestion_errors ?? 0);
    errorTotals.json_parse_errors += Number(row.json_parse_errors ?? 0);
  }

  const rollingSuccessRate = totalAttempted > 0 ? totalSucceeded / totalAttempted : null;
  const configuredPairSuccessRate =
    totalConfigured > 0 ? trueNumerator / totalConfigured : null;
  const status = lagSeconds == null || lagSeconds > maxLagSeconds ? "stale" : "ok";

  return {
    status,
    latest_cycle_at: lastRunDate ? lastRunDate.toISOString() : null,
    last_run: lastRunDate ? lastRunDate.toISOString() : null,
    lag_seconds: lagSeconds,
    healthy: lagSeconds !== null && lagSeconds <= maxLagSeconds,
    rolling_success_rate: rollingSuccessRate,
    configured_pair_success_rate: configuredPairSuccessRate,
    true_success_rate: {
      ...true_success_rate_detail,
      provider_focus: provider_focus ?? null,
    },
    pairs_configured_total: totalConfigured,
    rolling_window_cycles: rows.length,
    error_totals: errorTotals,
  };
}
