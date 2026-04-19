#!/usr/bin/env node
/**
 * Phase G Phase 1 — read-only sample of Kalshi-only / Polymarket-only sports canonical_market
 * slots. Classifies each sample row as semantic-mismatch (plausible same-event counterpart on
 * another slot) vs coverage gap (none passes heuristic), per phase-g-bilateral-linking-strategy.md.
 *
 * Env: DATABASE_URL
 * Optional: PMCI_PHASE1_SAMPLE=100 (per side)
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

const SAMPLE = Math.max(1, Number(process.env.PMCI_PHASE1_SAMPLE || "100"));
const JACCARD_MIN = 0.12;
const MIN_SIGNIFICANT_TOKENS = 2;
const STOP = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "at",
  "by",
  "is",
  "be",
  "as",
  "it",
  "if",
  "vs",
  "v",
  "will",
  "win",
  "yes",
  "no",
]);

function tokenize(title) {
  const raw = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return raw.filter((t) => t.length > 1 && !STOP.has(t));
}

function jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function significantOverlap(toksA, toksB) {
  const sa = new Set(toksA.filter((t) => t.length > 2));
  const sb = new Set(toksB.filter((t) => t.length > 2));
  let n = 0;
  for (const x of sa) if (sb.has(x)) n += 1;
  return n;
}

function plausibleCounterpart(soloTitle, counterTitle) {
  const ta = tokenize(soloTitle);
  const tb = tokenize(counterTitle);
  if (!ta.length || !tb.length) return { ok: false, score: 0 };
  const j = jaccard(ta, tb);
  const sig = significantOverlap(ta, tb);
  if (j >= JACCARD_MIN) return { ok: true, score: j };
  if (sig >= MIN_SIGNIFICANT_TOKENS) return { ok: true, score: j };
  const na = ta.join(" ");
  const nb = tb.join(" ");
  if (na.length >= 8 && nb.length >= 8 && (na.includes(nb) || nb.includes(na))) return { ok: true, score: j };
  return { ok: false, score: j };
}

function segmentBucket(row) {
  const sub = String(row.subcategory || "").toLowerCase();
  const title = String(row.solo_title || "").toLowerCase();
  const slug = String(row.event_slug || "").toLowerCase();
  const hay = `${title} ${slug}`;

  if (/nominee|president|senate|governor|election|republican|democrat|primary|caucus|house race/.test(hay))
    return "elections_politics";
  if (/draw|end in a draw|\.fc\b| bundesliga|premier league|champions league|mls cup|serie a|ligue 1|uefa/.test(hay))
    return "soccer";
  if (/inning|mlb|yankees|dodgers|first \d|runs\?|spread|total|over\/under|o\//.test(hay) || sub === "mlb")
    return "mlb_props";
  if (/nba|nfl|nhl|ncaa|wnba|ufc|mma|golf|tennis|f1|formula/.test(hay) || ["nba", "nfl", "nhl", "ncaa"].includes(sub))
    return "other_sports";
  return "other_sports";
}

const SQL_SOLO_BASE = `
  WITH active_map AS (
    SELECT pmm.canonical_market_id, pmm.provider_market_id, pmm.provider_id, pr.code AS provider_code
    FROM pmci.provider_market_map pmm
    JOIN pmci.providers pr ON pr.id = pmm.provider_id
    WHERE pmm.removed_at IS NULL
      AND (pmm.status IS NULL OR pmm.status = 'active')
  ),
  slot_agg AS (
    SELECT
      cm.id AS canonical_market_id,
      cm.canonical_event_id,
      ce.category,
      ce.subcategory,
      ce.slug AS event_slug,
      ce.title AS event_title,
      COUNT(*) FILTER (WHERE am.provider_code = 'kalshi') AS n_kalshi,
      COUNT(*) FILTER (WHERE am.provider_code = 'polymarket') AS n_poly
    FROM pmci.canonical_markets cm
    JOIN pmci.canonical_events ce ON ce.id = cm.canonical_event_id
    JOIN active_map am ON am.canonical_market_id = cm.id
    WHERE ce.category = 'sports'
    GROUP BY cm.id, cm.canonical_event_id, ce.category, ce.subcategory, ce.slug, ce.title
  )
  SELECT * FROM slot_agg
`;

async function sampleSlots(client, side) {
  const wantKalshi = side === "kalshi";
  const filter = wantKalshi ? "n_kalshi = 1 AND n_poly = 0" : "n_poly = 1 AND n_kalshi = 0";
  const sql = `
    ${SQL_SOLO_BASE}
    WHERE ${filter}
    ORDER BY hashtext(canonical_market_id::text || $2)
    LIMIT $1
  `;
  const seed = wantKalshi ? "phase1-kalshi-solo-v1" : "phase1-poly-solo-v1";
  const { rows } = await client.query(sql, [SAMPLE, seed]);
  return rows;
}

async function loadSoloMarketRow(client, canonicalMarketId) {
  const { rows } = await client.query(
    `SELECT pm.id, pm.title, pr.code AS provider_code
     FROM pmci.provider_market_map pmm
     JOIN pmci.provider_markets pm ON pm.id = pmm.provider_market_id
     JOIN pmci.providers pr ON pr.id = pm.provider_id
     WHERE pmm.canonical_market_id = $1::uuid
       AND pmm.removed_at IS NULL
       AND (pmm.status IS NULL OR pmm.status = 'active')
     LIMIT 1`,
    [canonicalMarketId],
  );
  return rows[0] || null;
}

async function loadCounterpartTitles(client, canonicalEventId, excludeMarketId, wantProvider) {
  const { rows } = await client.query(
    `SELECT pm.id, pm.title, pmm.canonical_market_id
     FROM pmci.provider_market_map pmm
     JOIN pmci.provider_markets pm ON pm.id = pmm.provider_market_id
     JOIN pmci.providers pr ON pr.id = pm.provider_id
     WHERE pmm.canonical_market_id IN (
         SELECT cm.id FROM pmci.canonical_markets cm WHERE cm.canonical_event_id = $1::uuid
       )
       AND pmm.canonical_market_id IS DISTINCT FROM $2::uuid
       AND pr.code = $3
       AND pmm.removed_at IS NULL
       AND (pmm.status IS NULL OR pmm.status = 'active')
       AND (pm.status IS NULL OR pm.status = 'active')`,
    [canonicalEventId, excludeMarketId, wantProvider],
  );
  return rows;
}

async function classifySample(client, slotRow, side) {
  const wantCounter = side === "kalshi" ? "polymarket" : "kalshi";
  const solo = await loadSoloMarketRow(client, slotRow.canonical_market_id);
  if (!solo) {
    return { segment: "unknown", kind: "coverage_gap", bestScore: 0, note: "no_solo_pm_row" };
  }
  const counters = await loadCounterpartTitles(
    client,
    slotRow.canonical_event_id,
    slotRow.canonical_market_id,
    wantCounter,
  );
  const seg = segmentBucket({ ...slotRow, solo_title: solo.title });
  if (counters.length === 0) {
    return {
      segment: seg,
      kind: "coverage_gap",
      bestScore: 0,
      note: "no_counterparty_rows_on_event",
    };
  }
  let bestAny = { ok: false, score: 0, title: "" };
  let firstOk = null;
  for (const c of counters) {
    const p = plausibleCounterpart(solo.title, c.title);
    if (p.score > bestAny.score) bestAny = { ok: p.ok, score: p.score, title: c.title };
    if (p.ok && !firstOk) firstOk = { p, exampleCounterTitle: c.title?.slice(0, 160) };
  }
  if (firstOk) {
    return {
      segment: seg,
      kind: "semantic_mismatch",
      bestScore: firstOk.p.score,
      note: "heuristic_match",
      exampleCounterTitle: firstOk.exampleCounterTitle,
    };
  }
  return {
    segment: seg,
    kind: "coverage_gap",
    bestScore: bestAny.score,
    note: "counterparty_present_but_low_similarity",
  };
}

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const kalshiSlots = await sampleSlots(client, "kalshi");
    const polySlots = await sampleSlots(client, "polymarket");

    const kalshiResults = [];
    for (const s of kalshiSlots) kalshiResults.push(await classifySample(client, s, "kalshi"));
    const polyResults = [];
    for (const s of polySlots) polyResults.push(await classifySample(client, s, "polymarket"));

    const summarize = (results, label) => {
      const mismatch = results.filter((r) => r.kind === "semantic_mismatch").length;
      const gap = results.length - mismatch;
      const bySeg = {};
      for (const r of results) {
        bySeg[r.segment] = bySeg[r.segment] || { mismatch: 0, gap: 0 };
        bySeg[r.segment][r.kind === "semantic_mismatch" ? "mismatch" : "gap"] += 1;
      }
      return { label, n: results.length, semantic_mismatch: mismatch, coverage_gap: gap, bySeg };
    };

    const out = {
      sample_size_per_side: SAMPLE,
      jaccard_min: JACCARD_MIN,
      min_significant_tokens: MIN_SIGNIFICANT_TOKENS,
      kalshi_solos: summarize(kalshiResults, "kalshi_only_slots"),
      poly_solos: summarize(polyResults, "polymarket_only_slots"),
    };
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await client.end();
  }
}

await main();
