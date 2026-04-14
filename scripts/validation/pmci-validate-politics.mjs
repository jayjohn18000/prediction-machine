#!/usr/bin/env node
/**
 * PMCI politics validation: DEM 2028 + GOP 2028 end-to-end health and signals.
 * Calls freshness, probe-style counts, per-event APIs for both UUIDs, optional coverage.
 * Exit 0 = all pass; non-zero = at least one failure.
 * Usage: API must be running (npm run api:pmci). Optional: baseUrl (default http://localhost:8787)
 */

const DEM_UUID = "c8515a58-c984-46fe-ac65-25e362e68333";
const GOP_UUID = "1679cc97-88b0-4ad4-a29c-b483ed94f6df";

const baseUrl = process.argv[2] || "http://localhost:8787";

const failures = [];
const results = { freshness: null, probe: null, dem: null, gop: null, coverage: null };

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`GET ${path} HTTP ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`GET ${path} HTTP ${res.status}: ${JSON.stringify(data)}`);
  if (data?.error) throw new Error(`GET ${path} error: ${JSON.stringify(data.error)}`);
  return data;
}

async function run() {
  // A) Freshness
  try {
    const freshness = await get("/v1/health/freshness");
    results.freshness = freshness;
    if (freshness.status !== "ok") {
      failures.push(`freshness status=${freshness.status} (expected ok)`);
    }
  } catch (e) {
    failures.push(`freshness: ${e.message}`);
  }

  // B) Data presence (counts from freshness or re-use)
  if (results.freshness?.counts) {
    const c = results.freshness.counts;
    results.probe = c;
    if (Number(c.provider_markets ?? 0) === 0) failures.push("provider_markets == 0");
    if (Number(c.snapshots ?? 0) === 0) failures.push("snapshots == 0");
    if (Number(c.families ?? 0) === 0) failures.push("families == 0");
    if (Number(c.current_links ?? 0) === 0) failures.push("current_links == 0");
  }

  // B2) Per-provider freshness: both kalshi and polymarket should have latest_snapshot_at
  if (results.freshness?.latest_by_provider) {
    const lbp = results.freshness.latest_by_provider;
    const byCode = new Map((lbp || []).map((r) => [r.provider, r]));
    const kal = byCode.get("kalshi");
    const poly = byCode.get("polymarket");
    if (!kal || !kal.latest_snapshot_at) {
      failures.push("freshness: kalshi latest_snapshot_at null");
    }
    if (!poly || !poly.latest_snapshot_at) {
      failures.push("freshness: polymarket latest_snapshot_at null");
    }
  }

  async function validateEvent(label, eventId) {
    const out = { familiesCount: 0, sampleFamilyId: null, linksCount: null, divergenceRows: null, topDivergences: [] };
    try {
      const families = await get(`/v1/market-families?event_id=${eventId}`);
      if (!Array.isArray(families) || families.length === 0) {
        failures.push(`${label}: market-families length 0`);
        return out;
      }
      out.familiesCount = families.length;
      const badNumLinks = families.filter((f) => Number(f.num_links ?? 0) !== 2);
      if (badNumLinks.length > 0) {
        failures.push(`${label}: ${badNumLinks.length} families with num_links != 2`);
      }
      const familyId = families[0]?.id;
      if (familyId == null) return out;
      out.sampleFamilyId = familyId;

      const links = await get(`/v1/market-links?family_id=${familyId}`);
      if (!Array.isArray(links)) {
        failures.push(`${label}: market-links not array`);
      } else {
        out.linksCount = links.length;
        if (links.length !== 2) failures.push(`${label}: market-links length ${links.length} (expected 2)`);
      }

      const divergence = await get(`/v1/signals/divergence?family_id=${familyId}`);
      if (!Array.isArray(divergence)) {
        failures.push(`${label}: signals/divergence not array`);
      } else {
        out.divergenceRows = divergence.length;
        // Optional: if both legs have price_yes we expect 2 rows; else can be 0 or 1
      }

      const topDiv = await get(`/v1/signals/top-divergences?event_id=${eventId}&limit=10`);
      const topFamilies = Array.isArray(topDiv?.families) ? topDiv.families : null;
      if (!topFamilies) {
        failures.push(`${label}: top-divergences missing families array`);
      } else {
        if (topFamilies.length > 10) failures.push(`${label}: top-divergences length ${topFamilies.length} > 10`);
        out.topDivergences = topFamilies.slice(0, 3);
        for (const row of topFamilies) {
          const legsWithPrice = (row.legs || []).filter((l) => l.price_yes != null);
          if (legsWithPrice.length >= 2 && row.max_divergence == null) {
            failures.push(`${label}: family_id ${row.family_id} has both prices but max_divergence null`);
          }
        }
      }
    } catch (e) {
      failures.push(`${label}: ${e.message}`);
    }
    return out;
  }

  // C) Per-event
  results.dem = await validateEvent("DEM", DEM_UUID);
  results.gop = await validateEvent("GOP", GOP_UUID);

  // D) Coverage (optional)
  try {
    const kalshi = await get("/v1/coverage/summary?provider=kalshi");
    const poly = await get("/v1/coverage/summary?provider=polymarket");
    results.coverage = { kalshi, polymarket: poly };
  } catch (e) {
    results.coverage = { error: e.message };
  }
  try {
    const newKalshi = await get("/v1/markets/new?provider=kalshi&since=24h&limit=5");
    const newPoly = await get("/v1/markets/new?provider=polymarket&since=24h&limit=5");
    if (!results.coverage) results.coverage = {};
    results.coverage.newKalshi = Array.isArray(newKalshi) ? newKalshi.length : -1;
    results.coverage.newPolymarket = Array.isArray(newPoly) ? newPoly.length : -1;
  } catch (_) {}

  // Summary
  const status = results.freshness?.status ?? "?";
  const lag = results.freshness?.lag_seconds ?? "?";
  const counts = results.freshness?.counts ?? {};
  console.log("PMCI politics validation");
  console.log("  freshness: status=%s lag_seconds=%s", status, lag);
  console.log("  counts: provider_markets=%s snapshots=%s families=%s current_links=%s",
    counts.provider_markets ?? "?",
    counts.snapshots ?? "?",
    counts.families ?? "?",
    counts.current_links ?? "?"
  );
  console.log("  DEM: families=%d sample_family_id=%s links=%s div_rows=%s top3=%s",
    results.dem.familiesCount,
    results.dem.sampleFamilyId ?? "—",
    results.dem.linksCount ?? "—",
    results.dem.divergenceRows ?? "—",
    results.dem.topDivergences?.length ?? 0
  );
  console.log("  GOP: families=%d sample_family_id=%s links=%s div_rows=%s top3=%s",
    results.gop.familiesCount,
    results.gop.sampleFamilyId ?? "—",
    results.gop.linksCount ?? "—",
    results.gop.divergenceRows ?? "—",
    results.gop.topDivergences?.length ?? 0
  );
  if (results.coverage && !results.coverage.error) {
    console.log("  coverage: kalshi total=%s polymarket total=%s new_24h kalshi=%s poly=%s",
      results.coverage.kalshi?.total_markets ?? "?",
      results.coverage.polymarket?.total_markets ?? "?",
      results.coverage.newKalshi ?? "?",
      results.coverage.newPolymarket ?? "?"
    );
  }
  if (failures.length > 0) {
    console.error("FAIL:");
    failures.forEach((f) => console.error("  -", f));
    process.exit(1);
  }
  console.log("PASS");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
