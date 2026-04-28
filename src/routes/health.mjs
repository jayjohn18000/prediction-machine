/**
 * /v1/health/* routes.
 */
import { getObserverHealth } from "../services/observer-health.mjs";
import { computeLiveFreshnessSnapshot } from "../services/runtime-status.mjs";

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
    try {
      const rts = await computeLiveFreshnessSnapshot({ query });
      if (!rts) {
        return {
          status: "error",
          error: "no_freshness_snapshot",
          message: "Could not compute live freshness aggregates",
        };
      }

      const now = new Date();
      const nowTs = now.getTime();
      const latest = rts.latest_snapshot_at ? new Date(rts.latest_snapshot_at) : null;
      const latestTs = latest ? latest.getTime() : null;
      const lagSeconds = latestTs == null ? null : Math.max(0, Math.round((nowTs - latestTs) / 1000));

      const latestByProvider = [
        { provider: "kalshi", latest_snapshot_at: rts.latest_kalshi_snapshot_at ?? null },
        { provider: "polymarket", latest_snapshot_at: rts.latest_polymarket_snapshot_at ?? null },
      ].map((p) => {
        const lp = p.latest_snapshot_at ? new Date(p.latest_snapshot_at) : null;
        const lpTs = lp ? lp.getTime() : null;
        const lpLag = lpTs == null ? null : Math.max(0, Math.round((nowTs - lpTs) / 1000));
        return {
          provider: p.provider,
          latest_snapshot_at: p.latest_snapshot_at,
          lag_seconds: lpLag,
          staleness_seconds: lpLag,
        };
      });

      const snapshots = rts.snapshot_count ?? 0;
      let status = "ok";
      if (!Number.isFinite(lagSeconds) || lagSeconds == null) {
        status = snapshots === 0 ? "error" : "stale";
      } else if (snapshots === 0) {
        status = "error";
      } else if (lagSeconds > MAX_LAG_SECONDS) {
        status = "stale";
      }

      return {
        status,
        api_version: PMCI_API_VERSION,
        now: now.toISOString(),
        latest_snapshot_at: latest ? latest.toISOString() : null,
        lag_seconds: lagSeconds,
        staleness_seconds: lagSeconds,
        latest_by_provider: latestByProvider,
        counts: {
          provider_markets: rts.provider_markets_count ?? 0,
          snapshots,
          families: rts.families_count ?? 0,
          current_links: rts.current_links_count ?? 0,
        },
      };
    } catch (err) {
      return {
        status: "error",
        error: "db_error",
        message: err.message,
      };
    }
  });

  app.get("/v1/health/slo", async (req, reply) => {
    const db = getDbMetrics();
    const p95 = percentile(requestMetrics.latenciesMs, 95);
    const errorRate = requestMetrics.total > 0 ? requestMetrics.errors / requestMetrics.total : 0;

    let freshness = null;
    let projection = null;
    try {
      const rts = await computeLiveFreshnessSnapshot({ query });
      if (!rts) {
        freshness = {
          status: "error",
          error: "no_freshness_snapshot",
          message: "Could not compute live freshness aggregates",
        };
        projection = {
          ready: false,
          error: "no_freshness_snapshot",
          message: "Could not compute live freshness aggregates",
          missing_steps: ["Check DATABASE_URL and DB connectivity"],
        };
      } else {
        const now = new Date();
        const nowTs = now.getTime();
        const latest = rts.latest_snapshot_at ? new Date(rts.latest_snapshot_at) : null;
        const latestTs = latest ? latest.getTime() : null;
        const lagSeconds = latestTs == null ? null : Math.max(0, Math.round((nowTs - latestTs) / 1000));

        const latestByProvider = [
          { provider: "kalshi", latest_snapshot_at: rts.latest_kalshi_snapshot_at ?? null },
          { provider: "polymarket", latest_snapshot_at: rts.latest_polymarket_snapshot_at ?? null },
        ].map((p) => {
          const lp = p.latest_snapshot_at ? new Date(p.latest_snapshot_at) : null;
          const lpTs = lp ? lp.getTime() : null;
          const lpLag = lpTs == null ? null : Math.max(0, Math.round((nowTs - lpTs) / 1000));
          return {
            provider: p.provider,
            latest_snapshot_at: p.latest_snapshot_at,
            lag_seconds: lpLag,
            staleness_seconds: lpLag,
          };
        });

        const providerMarkets = Number(rts.provider_markets_count ?? 0);
        const snapshots = Number(rts.snapshot_count ?? 0);
        const families = Number(rts.families_count ?? 0);
        const activeLinks = Number(rts.current_links_count ?? 0);

        let freshnessStatus = "ok";
        if (!Number.isFinite(lagSeconds) || lagSeconds == null) {
          freshnessStatus = snapshots === 0 ? "error" : "stale";
        } else if (snapshots === 0) {
          freshnessStatus = "error";
        } else if (lagSeconds > MAX_LAG_SECONDS) {
          freshnessStatus = "stale";
        }

        freshness = {
          status: freshnessStatus,
          api_version: PMCI_API_VERSION,
          now: now.toISOString(),
          latest_snapshot_at: latest ? latest.toISOString() : null,
          lag_seconds: lagSeconds,
          staleness_seconds: lagSeconds,
          latest_by_provider: latestByProvider,
          counts: {
            provider_markets: providerMarkets,
            snapshots,
            families,
            current_links: activeLinks,
          },
        };

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

        projection = {
          ready: providerMarketsPass && snapshotsPass && familiesPass && activeLinksPass && lagPass,
          api_version: PMCI_API_VERSION,
          checks,
          missing_steps: missingSteps,
        };
      }
    } catch (err) {
      freshness = { status: "error", error: "db_error", message: err.message, lag_seconds: null };
      projection = {
        ready: false,
        error: "db_error",
        message: err.message,
        missing_steps: ["Check DATABASE_URL and DB connectivity"],
      };
    }

    let observerHealth = null;
    try {
      observerHealth = await getObserverHealth({ query }, { maxLagSeconds: MAX_LAG_SECONDS });
      observerHealth = {
        ...observerHealth,
        api_version: PMCI_API_VERSION,
      };
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
      const rts = await computeLiveFreshnessSnapshot({ query });
      if (!rts) {
        reply.code(503);
        return {
          ready: false,
          error: "no_freshness_snapshot",
          message: "Could not compute live freshness aggregates",
          missing_steps: ["Check DATABASE_URL and DB connectivity"],
        };
      }

      const latest = rts.latest_snapshot_at ? new Date(rts.latest_snapshot_at) : null;
      const latestTs = latest ? latest.getTime() : null;
      const lagSeconds = latestTs == null ? null : Math.max(0, Math.round((Date.now() - latestTs) / 1000));

      const providerMarkets = Number(rts.provider_markets_count ?? 0);
      const snapshots = Number(rts.snapshot_count ?? 0);
      const families = Number(rts.families_count ?? 0);
      const activeLinks = Number(rts.current_links_count ?? 0);

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

      return {
        ready: providerMarketsPass && snapshotsPass && familiesPass && activeLinksPass && lagPass,
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
      const observerHealth = await getObserverHealth({ query }, { maxLagSeconds: MAX_LAG_SECONDS });
      return {
        ...observerHealth,
        api_version: PMCI_API_VERSION,
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
