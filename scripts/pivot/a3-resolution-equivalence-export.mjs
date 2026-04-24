#!/usr/bin/env node
/**
 * Agent A3: enumerate bilateral sports-linked families, fetch resolution text
 * from Kalshi + Polymarket CLOB APIs, emit CSV for equivalence audit.
 *
 * Usage: node scripts/pivot/a3-resolution-equivalence-export.mjs
 * Requires: DATABASE_URL
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";
import { fetchWithTimeout, retry } from "../../lib/retry.mjs";

loadEnv();

const KALSHI_BASES = [
  "https://api.elections.kalshi.com/trade-api/v2",
  "https://api.kalshi.com/trade-api/v2",
];
const POLY_CLOB = "https://clob.polymarket.com";

const SQL_FAMILIES = `
WITH bilateral_families AS (
  SELECT c.family_id
  FROM pmci.v_market_links_current c
  JOIN pmci.provider_markets pm ON pm.id = c.provider_market_id
  WHERE c.status = 'active' AND pm.category = 'sports'
  GROUP BY c.family_id
  HAVING COUNT(*) = 2 AND COUNT(DISTINCT c.provider_id) = 2
)
SELECT
  bf.family_id::text AS family_id,
  mf.label AS family_label,
  MAX(pm.id) FILTER (WHERE pr.code = 'kalshi') AS kalshi_internal_id,
  MAX(pm.id) FILTER (WHERE pr.code = 'polymarket') AS poly_internal_id,
  MAX(pm.provider_market_ref) FILTER (WHERE pr.code = 'kalshi') AS kalshi_market_id,
  MAX(pm.provider_market_ref) FILTER (WHERE pr.code = 'polymarket') AS poly_market_id,
  MAX(pm.sport) FILTER (WHERE pr.code = 'kalshi') AS sport,
  COALESCE(
    MAX(pm.event_type) FILTER (WHERE pr.code = 'kalshi'),
    MAX(pm.event_type) FILTER (WHERE pr.code = 'polymarket')
  ) AS event_type,
  MAX(pm.title) FILTER (WHERE pr.code = 'kalshi') AS kalshi_title,
  MAX(pm.title) FILTER (WHERE pr.code = 'polymarket') AS poly_title,
  (MAX(pm.game_date) FILTER (WHERE pr.code = 'kalshi'))::text AS kalshi_game_date,
  (MAX(pm.game_date) FILTER (WHERE pr.code = 'polymarket'))::text AS poly_game_date,
  MAX(pm.home_team) FILTER (WHERE pr.code = 'kalshi') AS kalshi_home,
  MAX(pm.away_team) FILTER (WHERE pr.code = 'kalshi') AS kalshi_away,
  MAX(pm.home_team) FILTER (WHERE pr.code = 'polymarket') AS poly_home,
  MAX(pm.away_team) FILTER (WHERE pr.code = 'polymarket') AS poly_away,
  MAX(pm.resolution_source) FILTER (WHERE pr.code = 'kalshi') AS resolution_source_kalshi_db,
  MAX(pm.resolution_source) FILTER (WHERE pr.code = 'polymarket') AS resolution_source_poly_db
FROM bilateral_families bf
JOIN pmci.v_market_links_current v
  ON v.family_id = bf.family_id AND v.status = 'active'
JOIN pmci.provider_markets pm ON pm.id = v.provider_market_id
JOIN pmci.providers pr ON pr.id = pm.provider_id
LEFT JOIN pmci.market_families mf ON mf.id = bf.family_id
GROUP BY bf.family_id, mf.label
ORDER BY bf.family_id::bigint;
`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normToken(s) {
  if (s == null || s === "") return "";
  return String(s)
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_TITLE = new Set([
  "will",
  "win",
  "the",
  "vs",
  "end",
  "in",
  "a",
  "an",
  "to",
  "of",
  "for",
  "at",
  "on",
  "draw",
  "winner",
  "game",
  "professional",
  "this",
  "market",
  "yes",
  "no",
  "sports",
  "2025",
  "2026",
  "2027",
  "2028",
]);

function significantTitleTokens(s) {
  return normToken(s || "")
    .split(" ")
    .filter((w) => w.length > 2 && !STOP_TITLE.has(w));
}

/**
 * Linking signal only (not resolution equivalence).
 * Do not use provider game_date deltas — many futures use placeholder end dates that differ by venue.
 * @returns {'yes'|'no'|'uncertain'}
 */
function inferSameEvent(row) {
  const kTokens = new Set(significantTitleTokens(row.kalshi_title));
  const pTokens = new Set(significantTitleTokens(row.poly_title));
  const shared = [...kTokens].filter((w) => pTokens.has(w));
  if (shared.length >= 2) return "yes";
  if (shared.length === 1 && shared[0].length >= 5) return "yes";

  const kn = normToken(row.kalshi_title);
  const pn = normToken(row.poly_title);
  if (kn.length > 12 && pn.length > 12) {
    if (pn.includes(kn.slice(0, Math.min(18, kn.length))) || kn.includes(pn.slice(0, Math.min(18, pn.length)))) {
      return "yes";
    }
  }

  const lab = normToken(row.family_label || "");
  if (lab && kn.length > 8 && pn.length > 8) {
    const labTok = significantTitleTokens(row.family_label);
    const kHit = labTok.filter((w) => w.length > 3 && kn.includes(w)).length;
    const pHit = labTok.filter((w) => w.length > 3 && pn.includes(w)).length;
    if (kHit >= 2 && pHit >= 2) return "yes";
  }

  const kNorm = normToken(row.kalshi_title);
  const pNorm = normToken(row.poly_title);
  const bothMlbSeason =
    (kNorm.includes("pro baseball championship") || kNorm.includes("world series")) &&
    (pNorm.includes("pro baseball championship") || pNorm.includes("world series"));
  const kalshiAthletics =
    kNorm.includes("a s") ||
    kNorm.includes("athletics") ||
    /\bas win\b/.test(kNorm) ||
    /\bas\b.*\bbaseball\b/.test(kNorm);
  const polyAthletics =
    pNorm.includes("a s") ||
    pNorm.includes("athletics") ||
    /\bas win\b/.test(pNorm) ||
    /\bas\b.*\bbaseball\b/.test(pNorm);
  const bothAthletics = kalshiAthletics && polyAthletics;
  if (bothMlbSeason && bothAthletics) return "yes";

  if (kTokens.size && pTokens.size && shared.length === 0) return "no";

  return "uncertain";
}

function joinKalshiRules(m) {
  if (!m) return "";
  const a = (m.rules_primary || "").trim();
  const b = (m.rules_secondary || "").trim();
  if (a && b) return `${a}\n\n${b}`;
  return a || b || "";
}

async function fetchKalshiMarket(ticker) {
  for (const base of KALSHI_BASES) {
    const url = `${base}/markets/${encodeURIComponent(ticker)}`;
    try {
      const res = await retry(
        () => fetchWithTimeout(url, {}, 20_000),
        { maxAttempts: 2, baseDelayMs: 400 },
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.market) return { base, market: data.market };
    } catch {
      /* try next base */
    }
  }
  return null;
}

async function fetchPolyMarket(conditionId) {
  const url = `${POLY_CLOB}/markets/${encodeURIComponent(conditionId)}`;
  try {
    const res = await retry(
      () => fetchWithTimeout(url, {}, 20_000),
      { maxAttempts: 2, baseDelayMs: 400 },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function extractResolutionSourceFromText(text) {
  if (!text) return "";
  const t = text.replace(/\s+/g, " ");
  const m =
    t.match(/resolution source (?:is|will be)[^.]{0,240}/i) ||
    t.match(/according to ([^.]{10,200})/i) ||
    t.match(/(?:verified by|based on) ([^.]{10,200})/i);
  return m ? m[0].trim().slice(0, 500) : "";
}

function regulationOvertimeSignals(text) {
  const tl = (text || "").toLowerCase();
  const regulationOnly =
    /\bregulation\b/.test(tl) &&
    (/excluding overtime|end of regulation|after regulation time|at the end of regulation|not including overtime/.test(
      tl,
    ) ||
      (/\bregulation\b/.test(tl) && !/\bovertime|extra innings|shootout/.test(tl)));
  const otExplicit =
    /\bincluding overtime\b|\bafter overtime\b|\bextra innings\b|\bshootout\b|\bovertime\b.*\b(includes|count)/.test(
      tl,
    );
  return { regulationOnly: regulationOnly && !otExplicit, otExplicit };
}

/**
 * Conservative v1 classifier — prefer ambiguous when unsure.
 * @returns {{ classification: string, classification_reason: string, timing_alignment: string, resolution_source_kalshi: string, resolution_source_poly: string, rules_provenance: string }}
 */
function classifyAuditFields(row) {
  const same = row.both_sides_reference_same_event;
  const kRules = row.kalshi_resolution_rules || "";
  const pRules = row.poly_resolution_rules || "";
  const kProv = row.rules_provenance_kalshi;
  const pProv = row.rules_provenance_poly;

  const timingK = regulationOvertimeSignals(kRules);
  const timingP = regulationOvertimeSignals(pRules);

  let timing_alignment = "unclear";
  if (timingK.otExplicit && timingP.otExplicit) timing_alignment = "both_allow_ot";
  else if (timingK.regulationOnly && timingP.otExplicit)
    timing_alignment = "kalshi_reg_poly_ot_misaligned";
  else if (timingP.regulationOnly && timingK.otExplicit)
    timing_alignment = "poly_reg_kalshi_ot_misaligned";
  else if (timingK.regulationOnly && timingP.regulationOnly)
    timing_alignment = "both_regulation_focused";
  else if (!kRules || !pRules) timing_alignment = "unclear";

  let resolution_source_kalshi =
    row.resolution_source_kalshi_db ||
    extractResolutionSourceFromText(kRules) ||
    "";
  let resolution_source_poly =
    row.resolution_source_poly_db ||
    extractResolutionSourceFromText(pRules) ||
    "";

  if (same === "no") {
    return {
      classification: "non_equivalent",
      classification_reason:
        "both_sides_reference_same_event=no — linked legs do not appear to reference the same fixture or entity; treat as linking or scope mismatch.",
      timing_alignment,
      resolution_source_kalshi,
      resolution_source_poly,
      rules_provenance: `${kProv};${pProv}`,
    };
  }

  if (kProv !== "api" || pProv !== "api") {
    return {
      classification: "ambiguous",
      classification_reason:
        "Resolution rules text missing or not retrieved from one or both venues; equivalence cannot be confirmed from rules alone.",
      timing_alignment,
      resolution_source_kalshi,
      resolution_source_poly,
      rules_provenance: `${kProv};${pProv}`,
    };
  }

  if (
    timing_alignment === "kalshi_reg_poly_ot_misaligned" ||
    timing_alignment === "poly_reg_kalshi_ot_misaligned"
  ) {
    return {
      classification: "non_equivalent",
      classification_reason:
        "Regulation vs overtime (or extra time) handling appears to differ between venues based on rules text keywords.",
      timing_alignment,
      resolution_source_kalshi,
      resolution_source_poly,
      rules_provenance: `${kProv};${pProv}`,
    };
  }

  const sk = normToken(resolution_source_kalshi);
  const sp = normToken(resolution_source_poly);
  if (sk && sp && sk !== sp && sk.length > 8 && sp.length > 8) {
    const overlap = [...tokens(resolution_source_kalshi)].filter((w) =>
      tokens(resolution_source_poly).has(w),
    ).length;
    if (overlap < 2) {
      return {
        classification: "ambiguous",
        classification_reason:
          "Resolution sources (or extracted source lines) differ; needs human read of full rules to confirm equivalence.",
        timing_alignment,
        resolution_source_kalshi,
        resolution_source_poly,
        rules_provenance: `${kProv};${pProv}`,
      };
    }
  }

  return {
    classification: "ambiguous",
    classification_reason:
      "Rules text retrieved; automated pass did not establish strict equivalence — owner review required before counting as equivalent.",
    timing_alignment,
    resolution_source_kalshi,
    resolution_source_poly,
    rules_provenance: `${kProv};${pProv}`,
  };
}

function csvEscape(val) {
  if (val == null) return "";
  const s = String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowToLine(obj, columns) {
  return columns.map((c) => csvEscape(obj[c])).join(",");
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let rows;
  try {
    const res = await client.query(SQL_FAMILIES);
    rows = res.rows;
  } finally {
    await client.end();
  }

  const outDir = path.resolve(process.cwd(), "docs/pivot/artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  const outCsv = path.join(outDir, "a3-resolution-equivalence-audit.csv");

  const columns = [
    "family_id",
    "family_label",
    "sport",
    "event_type",
    "kalshi_market_id",
    "poly_market_id",
    "kalshi_title",
    "poly_title",
    "kalshi_game_date",
    "poly_game_date",
    "both_sides_reference_same_event",
    "kalshi_resolution_rules",
    "poly_resolution_rules",
    "resolution_source_kalshi",
    "resolution_source_poly",
    "timing_alignment",
    "classification",
    "classification_reason",
    "rules_provenance",
  ];

  const lines = [columns.join(",")];
  const summary = {
    generatedAt: new Date().toISOString(),
    bilateral_sports_families: rows.length,
    same_event: { yes: 0, no: 0, uncertain: 0 },
    classification: { equivalent: 0, non_equivalent: 0, ambiguous: 0 },
  };

  let kalshiBaseUsed = null;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    process.stderr.write(`\rfetch ${i + 1}/${rows.length} family ${r.family_id}   `);

    const kTicker = r.kalshi_market_id;
    const pCond = r.poly_market_id;

    const kBundle = await fetchKalshiMarket(kTicker);
    if (kBundle?.base) kalshiBaseUsed = kBundle.base;
    const kMarket = kBundle?.market;
    const pMarket = await fetchPolyMarket(pCond);

    const kalshi_rules = joinKalshiRules(kMarket);
    const poly_rules = (pMarket?.description || "").trim();

    const rules_provenance_kalshi = kalshi_rules ? "api" : "missing";
    const rules_provenance_poly = poly_rules ? "api" : "missing";

    const baseRow = {
      ...r,
      kalshi_resolution_rules: kalshi_rules,
      poly_resolution_rules: poly_rules,
      rules_provenance_kalshi,
      rules_provenance_poly,
      both_sides_reference_same_event: inferSameEvent(r),
    };

    const audited = classifyAuditFields(baseRow);

    summary.same_event[baseRow.both_sides_reference_same_event]++;

    const out = {
      family_id: r.family_id,
      family_label: r.family_label ?? "",
      sport: r.sport ?? "",
      event_type: r.event_type ?? "",
      kalshi_market_id: r.kalshi_market_id,
      poly_market_id: r.poly_market_id,
      kalshi_title: r.kalshi_title ?? "",
      poly_title: r.poly_title ?? "",
      kalshi_game_date: r.kalshi_game_date ?? "",
      poly_game_date: r.poly_game_date ?? "",
      both_sides_reference_same_event: baseRow.both_sides_reference_same_event,
      kalshi_resolution_rules: kalshi_rules,
      poly_resolution_rules: poly_rules,
      resolution_source_kalshi: audited.resolution_source_kalshi,
      resolution_source_poly: audited.resolution_source_poly,
      timing_alignment: audited.timing_alignment,
      classification: audited.classification,
      classification_reason: audited.classification_reason,
      rules_provenance: audited.rules_provenance,
    };

    summary.classification[out.classification] =
      (summary.classification[out.classification] || 0) + 1;
    lines.push(rowToLine(out, columns));

    await sleep(120);
  }

  fs.writeFileSync(outCsv, lines.join("\n") + "\n", "utf8");

  const metaPath = path.join(outDir, "a3-resolution-equivalence-audit-summary.json");
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        ...summary,
        kalshi_api_base_observed: kalshiBaseUsed,
        csv_path: "docs/pivot/artifacts/a3-resolution-equivalence-audit.csv",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  process.stderr.write("\n");
  console.log(`Wrote ${outCsv}`);
  console.log(`Wrote ${metaPath}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
