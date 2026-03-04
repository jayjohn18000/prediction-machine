#!/usr/bin/env node

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

  console.log(`\nPMCI Projection Status  —  ${new Date().toISOString()}`);
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

