/**
 * /v1/health/* routes.
 */

// 10-second TTL cache for the freshness response.
// count(*) on 470K+ snapshot rows and v_market_links_current are the main contributors
// to the ~260ms freshness latency; caching the full result eliminates repeated scans
// on SLO polls and back-to-back signal requests that call assertFreshness.
const _freshnessCache = { data: null, fetchedAt: 0 };
const FRESHNESS_TTL_MS = 10_000;

export function registerHealthRoutes(app, deps) {
  const {
    query,
    getDbMetrics,
    requestMetrics,
    PMCI_API_VERSION,
    MAX_LAG_SECONDS,
    INGESTION_SUCCESS_TARGET,
    API_P95_TARGET_MS,
    percentile,
  } = deps;

  app.get("/v1/health/freshness", async () => {
    const cacheAge = Date.now() - _freshnessCache.fetchedAt;
    if (_freshnessCache.data && cacheAge < FRESHNESS_TTL_MS) {
      return _freshnessCache.data;
    }

    try {
      const { rows: sr } = await query(`
        select
          now() as now,
          (select max(observed_at) from pmci.provider_market_snapshots) as latest_snapshot_at,
          (select count(*)::bigint from pmci.provider_markets) as provider_markets,
          (select count(*)::bigint from pmci.provider_market_snapshots) as snapshots,
          (select count(*)::bigint from pmci.market_families) as families,
          (select count(*)::bigint from pmci.v_market_links_current) as current_links;
      `);
      const summary = sr[0] ?? {};
      const now = summary.now ? new Date(summary.now) : new Date();
      const latest = summary.latest_snapshot_at ? new Date(summary.latest_snapshot_at) : null;
      const nowTs = now.getTime();
      const latestTs = latest ? latest.getTime() : null;
      const lagSeconds = latestTs == null ? null : Math.max(0, Math.round((nowTs - latestTs) / 1000));

      // Faster: skip the providers join, group by provider_id directly, then join 2-row providers table.
      const providerCounts = await query(`
        select p.code as provider, q.latest_snapshot_at
        from pmci.providers p
        left join (
          select pm.provider_id, max(s.observed_at) as latest_snapshot_at
          from pmci.provider_markets pm
          join pmci.provider_market_snapshots s on s.provider_market_id = pm.id
          group by pm.provider_id
        ) q on q.provider_id = p.id
        order by p.code;
      `);

      const latestByProvider = (providerCounts.rows || []).map((r) => {
        const lp = r.latest_snapshot_at ? new Date(r.latest_snapshot_at) : null;
        const lpTs = lp ? lp.getTime() : null;
        const lpLag = lpTs == null ? null : Math.max(0, Math.round((nowTs - lpTs) / 1000));
        return {
          provider: r.provider,
          latest_snapshot_at: r.latest_snapshot_at ?? null,
          lag_seconds: lpLag,
        };
      });

      const snapshots = Number(summary.snapshots ?? 0);
      let status = "ok";
      if (!Number.isFinite(lagSeconds) || lagSeconds == null) {
        status = snapshots === 0 ? "error" : "stale";
      } else if (snapshots === 0) {
        status = "error";
      } else if (lagSeconds > MAX_LAG_SECONDS) {
        status = "stale";
      }

      const result = {
        status,
        api_version: PMCI_API_VERSION,
        now: now.toISOString(),
        latest_snapshot_at: latest ? latest.toISOString() : null,
        lag_seconds: lagSeconds,
        latest_by_provider: latestByProvider,
        counts: {
          provider_markets: Number(summary.provider_markets ?? 0),
          snapshots,
          families: Number(summary.families ?? 0),
          current_links: Number(summary.current_links ?? 0),
        },
      };
      _freshnessCache.data = result;
      _freshnessCache.fetchedAt = Date.now();
      return result;
    } catch (err) {
      return {
        status: "error",
        error: "db_error",
        message: err.message,
      };
    }
  });

  app.get("/v1/health/slo", async () => {
    const db = getDbMetrics();
    const p95 = percentile(requestMetrics.latenciesMs, 95);
    const errorRate = requestMetrics.total > 0 ? requestMetrics.errors / requestMetrics.total : 0;

    let freshness = null;
    try {
      const response = await app.inject({ method: "GET", url: "/v1/health/freshness" });
      freshness = response.json();
    } catch (_) {
      freshness = { status: "error", lag_seconds: null };
    }

    let projection = null;
    try {
      const projResponse = await app.inject({ method: "GET", url: "/v1/health/projection-ready" });
      projection = projResponse.json();
    } catch (_) {
      projection = {
        ready: false,
        error: "inject_failed",
        missing_steps: ["Could not reach /v1/health/projection-ready"],
      };
    }

    let observerHealth = null;
    try {
      const observerResponse = await app.inject({ method: "GET", url: "/v1/health/observer" });
      observerHealth = observerResponse.json();
    } catch (_) {
      observerHealth = { status: "error", rolling_success_rate: null };
    }

    const ingestionSuccessRate =
      observerHealth?.true_success_rate ?? observerHealth?.rolling_success_rate ?? null;

    const checks = {
      ingestion_success: {
        target: INGESTION_SUCCESS_TARGET,
        actual: ingestionSuccessRate,
        pass: typeof ingestionSuccessRate === "number"
          ? ingestionSuccessRate >= INGESTION_SUCCESS_TARGET
          : false,
      },
      api_p95_latency_ms: {
        target: API_P95_TARGET_MS,
        actual: p95 == null ? null : Math.round(p95),
        pass: p95 == null ? false : p95 <= API_P95_TARGET_MS,
      },
      freshness_lag_seconds: {
        target: MAX_LAG_SECONDS,
        actual: freshness?.lag_seconds ?? null,
        pass: typeof freshness?.lag_seconds === "number"
          ? freshness.lag_seconds <= MAX_LAG_SECONDS
          : false,
      },
      projection_ready: {
        target: true,
        actual: projection?.ready ?? false,
        pass: projection?.ready === true,
      },
    };

    const allPass = Object.values(checks).every((c) => c.pass === true);
    return {
      status: allPass ? "ok" : "degraded",
      started_at: requestMetrics.startedAt,
      api_version: PMCI_API_VERSION,
      request_metrics: {
        total: requestMetrics.total,
        errors: requestMetrics.errors,
        error_rate: Number(errorRate.toFixed(4)),
        p95_latency_ms: p95 == null ? null : Math.round(p95),
        sample_size: requestMetrics.latenciesMs.length,
      },
      db_metrics: db,
      freshness_health: freshness,
      projection_health: projection,
      observer_health: observerHealth,
      checks,
    };
  });

  app.get("/v1/health/projection-ready", async (req, reply) => {
    try {
      const { rows } = await query(`
        select
          (select count(*)::bigint from pmci.provider_markets) as provider_markets,
          (select count(*)::bigint from pmci.provider_market_snapshots) as snapshots,
          (select count(*)::bigint from pmci.market_families) as families,
          (select count(*)::bigint from pmci.v_market_links_current) as active_links,
          extract(
            epoch from (now() - (select max(observed_at) from pmci.provider_market_snapshots))
          )::int as lag_seconds;
      `);
      const row = rows[0] ?? {};

      const providerMarkets = Number(row.provider_markets ?? 0);
      const snapshots = Number(row.snapshots ?? 0);
      const families = Number(row.families ?? 0);
      const activeLinks = Number(row.active_links ?? 0);
      const lagRaw = row.lag_seconds;
      const lagSeconds =
        typeof lagRaw === "number" ? lagRaw : lagRaw == null ? null : Number(lagRaw);

      const providerMarketsPass = providerMarkets > 0;
      const snapshotsPass = snapshots > 0;
      const familiesPass = families > 0;
      const activeLinksPass = activeLinks > 0;
      const lagPass = typeof lagSeconds === "number" && lagSeconds <= MAX_LAG_SECONDS;

      const checks = {
        provider_markets: { count: providerMarkets, pass: providerMarketsPass },
        snapshots: { count: snapshots, pass: snapshotsPass },
        families: { count: families, pass: familiesPass },
        active_links: { count: activeLinks, pass: activeLinksPass },
        freshness_seconds: { lag: lagSeconds, pass: lagPass },
      };

      const missingSteps = [];
      if (!providerMarketsPass) missingSteps.push("Run observer: npm run start (wait 1 cycle)");
      if (!snapshotsPass) missingSteps.push("Observer running but no snapshots yet, wait for next cycle");
      if (!familiesPass) missingSteps.push("Seed families: npm run seed:pmci");
      if (!activeLinksPass) missingSteps.push("No active links in v_market_links_current, check migrations");
      if (typeof lagSeconds === "number" && lagSeconds > MAX_LAG_SECONDS) {
        missingSteps.push(`Snapshots stale (${lagSeconds}s), restart observer: npm run start`);
      }

      const ready =
        providerMarketsPass && snapshotsPass && familiesPass && activeLinksPass && lagPass;

      return {
        ready,
        api_version: PMCI_API_VERSION,
        checks,
        missing_steps: missingSteps,
      };
    } catch (err) {
      reply.code(503);
      return {
        ready: false,
        error: "db_error",
        message: err.message,
        missing_steps: ["Check DATABASE_URL and DB connectivity"],
      };
    }
  });

  app.get("/v1/health/observer", async (req, reply) => {
    try {
      const { rows } = await query(deps.SQL.observer_health);
      if (rows.length === 0) {
        return {
          status: "no_data",
          latest_cycle_at: null,
          lag_seconds: null,
          rolling_success_rate: null,
          rolling_window_cycles: 0,
          error_totals: null,
        };
      }
      const latest = rows[0];
      const latestCycleAt = latest.cycle_at ? new Date(latest.cycle_at) : null;
      const lagSeconds = latestCycleAt
        ? Math.max(0, Math.round((Date.now() - latestCycleAt.getTime()) / 1000))
        : null;

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
      const status = lagSeconds == null || lagSeconds > MAX_LAG_SECONDS ? "stale" : "ok";

      return {
        status,
        latest_cycle_at: latestCycleAt ? latestCycleAt.toISOString() : null,
        lag_seconds: lagSeconds,
        api_version: PMCI_API_VERSION,
        rolling_success_rate: rollingSuccessRate,
        true_success_rate: trueSuccessRate,
        pairs_configured_total: totalConfigured,
        rolling_window_cycles: rows.length,
        error_totals: errorTotals,
      };
    } catch (err) {
      reply.code(500);
      return { status: "error", error: "db_error", message: err.message };
    }
  });

  app.get("/v1/health/usage", async (req, reply) => {
    try {
      const { rows } = await query(`
        select
          path,
          count(*)::int as total_requests,
          round(avg(latency_ms))::int as avg_latency_ms,
          sum(case when status >= 500 then 1 else 0 end)::int as error_count,
          max(logged_at) as last_seen_at
        from pmci.request_log
        where logged_at > now() - interval '24 hours'
        group by path
        order by total_requests desc
      `);
      return { window: "24h", endpoints: rows };
    } catch (err) {
      reply.code(500);
      return { error: "db_error", message: err.message };
    }
  });
}
