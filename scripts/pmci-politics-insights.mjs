#!/usr/bin/env node
/**
 * PMCI Politics Insights
 *
 * Dynamically discovers all political canonical events from the API, then reports:
 *   - Overlapping (cross-provider linked) markets with live divergence signals
 *   - Non-overlapping (Kalshi-only / Polymarket-only) markets with coverage metrics
 *
 * Usage:
 *   node scripts/pmci-politics-insights.mjs [baseUrl]
 *
 * Env:
 *   PMCI_API_KEY   — optional API key (x-pmci-api-key header)
 *   PMCI_BASE_URL  — optional base URL override (default: http://localhost:8787)
 */

const BASE_URL = process.argv[2] ?? process.env.PMCI_BASE_URL ?? "http://localhost:8787";
const API_KEY = process.env.PMCI_API_KEY ?? null;

function headers() {
  const h = { "Content-Type": "application/json" };
  if (API_KEY) h["x-pmci-api-key"] = API_KEY;
  return h;
}

async function get(path) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok && res.status !== 503) {
    throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  return { status: res.status, body };
}

function pct(ratio) {
  if (ratio == null) return "n/a";
  return (Number(ratio) * 100).toFixed(1) + "%";
}

function fmt(n, decimals = 4) {
  if (n == null) return "  n/a  ";
  return Number(n).toFixed(decimals);
}

function pad(s, n) {
  const str = String(s ?? "");
  return str.length >= n ? str.slice(0, n) : str + " ".repeat(n - str.length);
}

function line(char = "─", n = 56) {
  return char.repeat(n);
}

const SEP = "═".repeat(56);

// ── 1. Freshness ──────────────────────────────────────────────
const { status: freshStatus, body: fresh } = await get("/v1/health/freshness");
const isStale = fresh.status !== "ok";

console.log(`\n${SEP}`);
console.log(`  PMCI POLITICS INSIGHTS  —  ${new Date().toISOString()}`);
console.log(SEP);

console.log(`\n── SYSTEM STATUS ${line("─", 39)}`);
const lag = fresh.lag_seconds != null ? `${fresh.lag_seconds}s` : "unknown";
const freshLabel = isStale ? "STALE ⚠" : "ok";
console.log(`  Freshness:   ${freshLabel}  (lag: ${lag})`);
if (isStale) {
  console.log(`  WARNING: Data is stale — divergence signals may be unavailable.`);
}
const counts = fresh.counts ?? {};
console.log(`  Markets:     ${counts.provider_markets ?? "?"} provider markets  |  ${counts.snapshots ?? "?"} snapshots`);
console.log(`  Families:    ${counts.families ?? "?"}  |  Links: ${counts.current_links ?? "?"}`);

// ── 2. Canonical events ───────────────────────────────────────
const { body: events } = await get("/v1/canonical-events?category=politics");
const canonicalEvents = Array.isArray(events) ? events : [];

console.log(`\n── POLITICAL UNIVERSE ${line("─", 34)}`);
console.log(`  Canonical events: ${canonicalEvents.length}  (category: politics)`);

if (canonicalEvents.length === 0) {
  console.log(`  WARNING: No canonical events found. Overlapping market section will be empty.`);
  console.log(`  (Run: npm run seed:pmci  to create canonical events and families.)`);
}

// ── 3. For each event: families + divergences ─────────────────
const allFamilies = [];           // { eventSlug, family, divergences }
const overlappingFamilies = [];   // num_links >= 2
const singleProviderFamilies = [];

for (const ev of canonicalEvents) {
  const { body: famRows } = await get(`/v1/market-families?event_id=${ev.id}`);
  const families = Array.isArray(famRows) ? famRows : [];

  let divRows = [];
  if (!isStale) {
    const { status: divStatus, body: divBody } = await get(
      `/v1/signals/top-divergences?event_id=${ev.id}&limit=50`
    );
    if (divStatus === 200 && divBody && typeof divBody === "object") {
      divRows = Array.isArray(divBody.families) ? divBody.families : [];
    }
  }

  const divByFamily = new Map(divRows.map(d => [d.family_id, d]));

  const famCount = families.length;
  console.log(`    • ${ev.slug ?? ev.id}  (${famCount} famil${famCount === 1 ? "y" : "ies"})`);

  for (const f of families) {
    const div = divByFamily.get(f.id) ?? null;
    allFamilies.push({ event: ev, family: f, div });
    if (f.num_links >= 2) {
      overlappingFamilies.push({ event: ev, family: f, div });
    } else {
      singleProviderFamilies.push({ event: ev, family: f, div });
    }
  }
}

// ── 4. Coverage summary ────────────────────────────────────────
// No category filter: linked markets use slug-based categories (e.g. democratic-presidential-
// nominee-2028), not 'politics'. Filtering by category=politics would show 0% coverage since
// linked rows live under their slug categories. All 1336 provider_markets are political in nature.
const [{ body: kalshiCov }, { body: polyCov }] = await Promise.all([
  get("/v1/coverage/summary?provider=kalshi"),
  get("/v1/coverage/summary?provider=polymarket"),
]);

// ── 5. Unlinked markets ────────────────────────────────────────
const [{ body: kalshiUnlinked }, { body: polyUnlinked }] = await Promise.all([
  get("/v1/markets/unlinked?provider=kalshi&category=politics&limit=100"),
  get("/v1/markets/unlinked?provider=polymarket&category=politics&limit=100"),
]);
const kalshiUnlinkedList = Array.isArray(kalshiUnlinked) ? kalshiUnlinked : [];
const polyUnlinkedList = Array.isArray(polyUnlinked) ? polyUnlinked : [];

// ── 6. Report: overlapping ─────────────────────────────────────
console.log(`\n── OVERLAPPING MARKETS (cross-provider linked) ${line("─", 9)}`);
console.log(`  Total linked families: ${overlappingFamilies.length}`);
console.log(`  Kalshi + Polymarket coverage:`);
if (kalshiCov && !kalshiCov.error) {
  console.log(`    Kalshi:     ${kalshiCov.linked_markets}/${kalshiCov.total_markets}  (${pct(kalshiCov.coverage_ratio)})`);
}
if (polyCov && !polyCov.error) {
  console.log(`    Polymarket: ${polyCov.linked_markets}/${polyCov.total_markets}  (${pct(polyCov.coverage_ratio)})`);
}

// Build divergence table from overlapping families
const divRows = overlappingFamilies
  .filter(({ div }) => div != null && div.max_divergence != null)
  .sort((a, b) => Number(b.div.max_divergence) - Number(a.div.max_divergence));

if (divRows.length === 0) {
  if (isStale) {
    console.log(`\n  (Divergence signals unavailable — data is stale.)`);
  } else if (overlappingFamilies.length === 0) {
    console.log(`\n  (No linked families found.)`);
  } else {
    console.log(`\n  (No divergence data available yet.)`);
  }
} else {
  console.log(`\n  Top divergences (sorted by max_divergence desc):`);
  const C = [33, 8, 8, 8, 10];
  const hdr =
    "  ┌" + line("─", C[0] + 2) + "┬" + line("─", C[1] + 2) + "┬" + line("─", C[2] + 2) +
    "┬" + line("─", C[3] + 2) + "┬" + line("─", C[4] + 2) + "┐";
  const mid =
    "  ├" + line("─", C[0] + 2) + "┼" + line("─", C[1] + 2) + "┼" + line("─", C[2] + 2) +
    "┼" + line("─", C[3] + 2) + "┼" + line("─", C[4] + 2) + "┤";
  const bot =
    "  └" + line("─", C[0] + 2) + "┴" + line("─", C[1] + 2) + "┴" + line("─", C[2] + 2) +
    "┴" + line("─", C[3] + 2) + "┴" + line("─", C[4] + 2) + "┘";

  function row(label, event, k, p, div) {
    return (
      "  │ " + pad(label, C[0]) + " │ " + pad(event, C[1]) + " │ " +
      pad(k, C[2]) + " │ " + pad(p, C[3]) + " │ " + pad(div, C[4]) + " │"
    );
  }

  console.log(hdr);
  console.log(row("Label", "Event", "Kalshi", "Poly", "Divergence"));
  console.log(mid);

  for (const { event, family, div } of divRows) {
    const legs = div?.legs ?? [];
    const kalshiLeg = legs.find(l => l.provider === "kalshi");
    const polyLeg = legs.find(l => l.provider === "polymarket");

    // Only show if both legs have a price
    if (kalshiLeg?.price_yes == null || polyLeg?.price_yes == null) continue;

    const label = (family.label ?? "").slice(0, C[0]);
    const evSlug = (event.slug ?? event.id ?? "").slice(0, C[1]);
    console.log(row(
      label, evSlug,
      fmt(kalshiLeg.price_yes, 4),
      fmt(polyLeg.price_yes, 4),
      fmt(div.max_divergence, 4),
    ));
  }

  console.log(bot);
}

// ── 7. Report: non-overlapping ─────────────────────────────────
console.log(`\n── NON-OVERLAPPING MARKETS ${line("─", 29)}`);
console.log(`  Kalshi-only:     ${kalshiUnlinkedList.length} unlinked markets`);
console.log(`  Polymarket-only: ${polyUnlinkedList.length} unlinked markets`);

console.log(`\n  Kalshi-only (top 20):`);
for (const m of kalshiUnlinkedList.slice(0, 20)) {
  console.log(`    • ${m.title}  [${m.provider_market_ref ?? ""}]  status=${m.status ?? "?"}`);
}
if (kalshiUnlinkedList.length === 0) console.log(`    (none)`);

console.log(`\n  Polymarket-only (top 20):`);
for (const m of polyUnlinkedList.slice(0, 20)) {
  console.log(`    • ${m.title}  [${m.provider_market_ref ?? ""}]  status=${m.status ?? "?"}`);
}
if (polyUnlinkedList.length === 0) console.log(`    (none)`);

// ── 8. Summary ────────────────────────────────────────────────
const familiesWithDiv = allFamilies.filter(({ div }) => div?.max_divergence != null);
const maxDiv = familiesWithDiv.length > 0
  ? Math.max(...familiesWithDiv.map(({ div }) => Number(div.max_divergence)))
  : null;

console.log(`\n── SUMMARY ${line("─", 44)}`);
console.log(`  Overlapping (linked):      ${overlappingFamilies.length} families  across ${canonicalEvents.length} events`);
console.log(`  Kalshi-only:               ${kalshiUnlinkedList.length} markets`);
console.log(`  Polymarket-only:           ${polyUnlinkedList.length} markets`);
if (kalshiCov && !kalshiCov.error) {
  console.log(`  Kalshi coverage ratio:     ${pct(kalshiCov.coverage_ratio)}`);
}
if (polyCov && !polyCov.error) {
  console.log(`  Polymarket coverage ratio: ${pct(polyCov.coverage_ratio)}`);
}
console.log(`  Families with divergence:  ${familiesWithDiv.length}  (max: ${maxDiv != null ? fmt(maxDiv, 4) : "n/a"})`);
console.log(`${SEP}\n`);
