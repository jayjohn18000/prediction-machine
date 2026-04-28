export async function getObserverHealth(db, options = {}) {
  const maxLagSeconds = Number(options.maxLagSeconds ?? 120);
  const observerWindow = Number(options.observerWindow ?? 20);

  const [lastRunAgg, heartbeatResult] = await Promise.all([
    db.query(`
      SELECT MAX(cycle_at) AS observer_last_run
      FROM pmci.observer_heartbeats
    `),
    db.query(`
      select cycle_at, pairs_attempted, pairs_succeeded, pairs_configured,
        kalshi_fetch_errors, polymarket_fetch_errors,
        spread_insert_errors, pmci_ingestion_errors, json_parse_errors
      from pmci.observer_heartbeats
      order by cycle_at desc
      limit $1
    `, [observerWindow]),
  ]);

  const lastRun = lastRunAgg.rows[0]?.observer_last_run ?? null;
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
      true_success_rate: null,
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
  const trueSuccessRate = totalConfigured > 0 ? trueNumerator / totalConfigured : null;
  const status = lagSeconds == null || lagSeconds > maxLagSeconds ? "stale" : "ok";

  return {
    status,
    latest_cycle_at: lastRunDate ? lastRunDate.toISOString() : null,
    last_run: lastRunDate ? lastRunDate.toISOString() : null,
    lag_seconds: lagSeconds,
    healthy: lagSeconds !== null && lagSeconds <= maxLagSeconds,
    rolling_success_rate: rollingSuccessRate,
    true_success_rate: trueSuccessRate,
    pairs_configured_total: totalConfigured,
    rolling_window_cycles: rows.length,
    error_totals: errorTotals,
  };
}
