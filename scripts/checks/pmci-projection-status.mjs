#!/usr/bin/env node
/**
 * npm run pmci:status — API health (freshness, SLO, projection-ready) plus optional DB snapshot
 * when DATABASE_URL is set: smoke counts, pending proposals by category, active links by category,
 * observer heartbeat lag.
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";
import { fetchPmciStatusBundle } from "../lib/pmci-status-queries.mjs";

loadEnv();

const { Client } = pg;

const baseEnv = process.env.PMCI_API_URL;
const argBase = process.argv[2];
const baseUrl = (baseEnv && baseEnv.trim()) || (argBase && argBase.trim()) || "http://localhost:8787";

async function main() {
  const [freshnessRes, sloRes, projRes] = await Promise.allSettled([
    fetch(`${baseUrl}/v1/health/freshness`).then((r) => r.json()),
    fetch(`${baseUrl}/v1/health/slo`).then((r) => r.json()),
    fetch(`${baseUrl}/v1/health/projection-ready`).then((r) => r.json()),
  ]);

  const freshness =
    freshnessRes.status === "fulfilled"
      ? freshnessRes.value
      : { status: "error", error: "fetch_failed" };
  const slo =
    sloRes.status === "fulfilled"
      ? sloRes.value
      : { status: "error", error: "fetch_failed" };
  const proj =
    projRes.status === "fulfilled"
      ? projRes.value
      : { ready: false, error: "fetch_failed" };

  console.log(`\nPMCI Status  —  ${new Date().toISOString()}`);
  console.log(`API: ${baseUrl}\n`);

  const lagLabel =
    freshness && typeof freshness.lag_seconds === "number"
      ? `${freshness.lag_seconds}s`
      : "unknown";
  const freshIcon =
    freshness?.status === "ok"
      ? "✓"
      : freshness?.status === "stale"
        ? "⚠"
        : "✗";
  console.log(`${freshIcon} Freshness       ${freshness?.status ?? "unknown"}  (lag: ${lagLabel})`);

  const projIcon = proj?.ready ? "✓" : "✗";
  console.log(`${projIcon} Projection      ${proj?.ready ? "ready" : "not ready"}`);
  if (proj?.checks) {
    const c = proj.checks;
    console.log(
      `   provider_markets: ${c.provider_markets?.count ?? "?"}  families: ${
        c.families?.count ?? "?"
      }  links: ${c.active_links?.count ?? "?"}  snapshots: ${
        c.snapshots?.count ?? "?"
      }`,
    );
  }
  if (Array.isArray(proj?.missing_steps) && proj.missing_steps.length > 0) {
    proj.missing_steps.forEach((s) => console.log(`   → ${s}`));
  }

  const sloIcon = slo?.status === "ok" ? "✓" : "⚠";
  console.log(`${sloIcon} SLO             ${slo?.status ?? "unknown"}`);
  if (slo?.checks && typeof slo.checks === "object") {
    Object.entries(slo.checks).forEach(([key, val]) => {
      if (!val || typeof val !== "object") return;
      const icon = val.pass ? "✓" : "✗";
      console.log(
        `   ${icon} ${key}: actual=${val.actual ?? "null"} target=${val.target}`,
      );
    });
  }

  const dbUrl = process.env.DATABASE_URL?.trim();
  if (dbUrl) {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      const bundle = await fetchPmciStatusBundle(client);
      console.log("\n— Database (DATABASE_URL) —");
      const s = bundle.smoke;
      console.log(
        `  provider_markets: ${s.provider_markets ?? "?"}  snapshots: ${s.snapshots ?? "?"}  ` +
          `families: ${s.families ?? "?"}  v_market_links_current: ${s.current_links ?? "?"}`,
      );
      if (bundle.pending_proposals?.length) {
        console.log("  pending proposed_links (decision IS NULL) by category:");
        for (const r of bundle.pending_proposals) {
          console.log(`    ${r.category ?? "(null)"}: ${r.cnt}`);
        }
      } else {
        console.log("  pending proposed_links: none");
      }
      if (bundle.active_links_by_category?.length) {
        console.log("  active market_links by category:");
        for (const r of bundle.active_links_by_category) {
          console.log(`    ${r.category ?? "(null)"}: ${r.active_link_rows}`);
        }
      }
      const ob = bundle.observer;
      if (ob?.cycle_at) {
        const lag = ob.lag_seconds != null ? `${ob.lag_seconds}s` : "?";
        console.log(
          `  observer_heartbeats: last cycle_at=${ob.cycle_at} lag≈${lag} ` +
            `(pairs ok ${ob.pairs_succeeded ?? "?"}/${ob.pairs_attempted ?? "?"})`,
        );
      } else {
        console.log("  observer_heartbeats: no rows");
      }
    } finally {
      await client.end();
    }
  } else {
    console.log("\n(DATABASE_URL unset — skipping DB counts / proposals / observer table.)");
  }

  const overallOk =
    freshness?.status === "ok" && proj?.ready === true && slo?.status === "ok";
  console.log(
    `\n${
      overallOk
        ? "✓ All systems operational"
        : "⚠ Action required — see items above"
    }\n`,
  );

  process.exit(overallOk ? 0 : 1);
}

main().catch((err) => {
  console.error("Unexpected error in pmci-projection-status:", err?.message ?? err);
  console.error(err?.stack ?? "");
  console.log("\n⚠ Action required — see errors above\n");
  process.exit(1);
});
