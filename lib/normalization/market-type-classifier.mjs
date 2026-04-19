/**
 * Phase G: Polymarket title → coarse market type + PMCI sports template keys.
 * Output templates align with lib/matching/sports-helpers.mjs SPORTS_BUCKET_TO_TEMPLATE.
 *
 * Team extraction for matchup titles must strip market-type tails **before** splitting on vs/at/@;
 * see `stripSportsMarketTypeSuffixForTeamTitle` and `extractSportsMatchupTeamsFromTitle`.
 */

import { SPORTS_BUCKET_TO_TEMPLATE, looksLikeMatchupMarket } from "../matching/sports-helpers.mjs";

/**
 * Ordered patterns: first match wins. Buckets match sports-helpers classifyMarketTypeBucket names.
 */
const PHASE_G_SPORTS_PATTERNS = [
  // Soccer / matchup draw (Phase 3): Polymarket "Will A vs B end in a draw?" must share
  // sports-moneyline with Kalshi draw phrasing; keep before generic `will … win` rules.
  { bucket: "moneyline_winner", pattern: /\b(?:match\s+)?(?:to\s+)?end\s+in\s+(?:a\s+)?draw\b/i },
  { bucket: "moneyline_winner", pattern: /\bwill\s+.+\s+(?:vs\.?|@|at)\s+.+\s+end\s+in\s+(?:a\s+)?draw\b/i },
  { bucket: "moneyline_winner", pattern: /\bwill\s+.+\s+end\s+in\s+(?:a\s+)?draw\b/i },
  // MLB / baseball framed run markets (Phase 2): must classify as totals before generic moneyline.
  { bucket: "totals", pattern: /\bfirst\s+\d+\s+innings?\s+runs?\b/i },
  { bucket: "totals", pattern: /\b\d+(?:st|nd|rd|th)\s+innings?\s+runs?\b/i },
  { bucket: "totals", pattern: /\b(over|under)\s+\d+(?:\.\d+)?\s+runs?\b/i },
  { bucket: "moneyline_winner", pattern: /\bwill .+ win the 20\d{2}(-\d{2})? .*(mvp|rookie|defensive|cy young|award|trophy)\b/i },
  { bucket: "moneyline_winner", pattern: /\bwill .+ win the 20\d{2}(-\d{2})? .*(series|championship|league|cup|trophy)\b/i },
  { bucket: "moneyline_winner", pattern: /\bwill .+ win .*(world series|super bowl|stanley cup|champions league)\b/i },
  { bucket: "moneyline_winner", pattern: /\bmake the .* playoffs\b/i },
  { bucket: "moneyline_winner", pattern: /\bwinner\b\??$/i },
  { bucket: "totals", pattern: /\bO\/U \d+\.?\d*\b/i },
  { bucket: "totals", pattern: /\bover\/under\b/i },
  { bucket: "totals", pattern: /\btotal (runs|goals|points|score)\b/i },
  { bucket: "spread", pattern: /^spread:/i },
  { bucket: "spread", pattern: /\(-?\d+\.5\)\s*$/i },
  { bucket: "btts", pattern: /\bboth teams to score\b/i },
  { bucket: "moneyline_winner", pattern: /\bwinner\b\??$/i },
  { bucket: "moneyline_winner", pattern: /^will .+ win\b/i },
  { bucket: "moneyline_winner", pattern: /\bwill .+ beat\b/i },
  { bucket: "moneyline_winner", pattern: /\bwill .+ defeat\b/i },
  { bucket: "spread", pattern: /\bspread\b/i },
  { bucket: "totals", pattern: /\bover\b.*\bunder\b/i },
];

/**
 * Extra slot discriminators for sports-moneyline / totals / spread (Phase G Phase 2).
 * @param {string} title
 * @param {string} _ref — reserved for provider-native line hints
 * @param {string} bucket
 */
function extractPhaseGAuxSlotParams(title, _ref, bucket) {
  const out = {};
  const t = String(title || "");
  const inn = t.match(/\bfirst\s+(\d+)\s+innings?\b/i);
  if (inn) out.innings_cap = Number(inn[1]);
  const innOrd = t.match(/\b(\d+)(?:st|nd|rd|th)\s+innings?\b/i);
  if (out.innings_cap == null && innOrd) out.innings_cap = Number(innOrd[1]);

  if (bucket === "totals") {
    const ou = t.match(/\b(over|under)\s+(\d+(?:\.\d+)?)\b/i);
    if (ou) {
      out.line = Number(ou[2]);
      out.side = ou[1].toLowerCase() === "under" ? "under" : "over";
    }
    const oosu = t.match(/\bO\/U\s+(\d+(?:\.\d+)?)\b/i);
    if (out.line == null && oosu) out.line = Number(oosu[1]);
  }

  if (bucket === "spread") {
    const spreadHand = t.match(/\([+-]?(\d+(?:\.\d+)?)\)/);
    if (spreadHand) out.line = Number(spreadHand[1]);
  }

  return out;
}

/**
 * @param {string | { title?: string, provider_market_ref?: string }} titleOrMarket
 * @returns {{ template: string, params: Record<string, unknown> } | null}
 */
export function classifyPhaseGSportsMarketType(titleOrMarket) {
  const t =
    typeof titleOrMarket === "string"
      ? String(titleOrMarket || "")
      : String(titleOrMarket?.title || "");
  const ref =
    typeof titleOrMarket === "object" && titleOrMarket != null
      ? String(titleOrMarket.provider_market_ref || "")
      : "";
  if (!t.trim()) return null;
  for (const { bucket, pattern } of PHASE_G_SPORTS_PATTERNS) {
    if (!pattern.test(t)) continue;
    const template = SPORTS_BUCKET_TO_TEMPLATE[bucket];
    if (!template) continue;
    const aux = extractPhaseGAuxSlotParams(t, ref, bucket);
    return {
      template,
      params: { bucket, source: "phase_g_market_type_classifier", ...aux },
    };
  }
  return null;
}

/**
 * End-anchored tails to remove before "Team A vs Team B" splitting.
 * Order: more specific phrases first; each pass may strip one tail (loop until stable).
 */
const TEAM_TITLE_SUFFIX_STRIP_PATTERNS = [
  /\s+first\s+\d+\s+innings?\s+runs?\??$/i,
  /\s+first\s+\d+\s+innings?\??$/i,
  /\s+first\s+inning\s+runs?\??$/i,
  /\s+first\s+inning\s+run\??$/i,
  /\s+first\s+inning\??$/i,
  /\s+\d+(?:st|nd|rd|th)\s+innings?\s+runs?\??$/i,
  /\s+\d+(?:st|nd|rd|th)\s+innings?\??$/i,
  /\s+\d+(?:st|nd|rd|th)\s+quarter\b.*$/i,
  /\s+\d+(?:st|nd|rd|th)\s+half\b.*$/i,
  /\s+\d+(?:st|nd|rd|th)\s+period\b.*$/i,
  /\s+first\s+half\b.*$/i,
  /\s+second\s+half\b.*$/i,
  /\s+first\s+quarter\b.*$/i,
  /\s+second\s+quarter\b.*$/i,
  /\s+third\s+quarter\b.*$/i,
  /\s+fourth\s+quarter\b.*$/i,
  /\s+both\s+teams?\s+to\s+score\b.*$/i,
  /\s+btts\b.*$/i,
  /\s+total\s+runs?\s*(?:\([^)]*\))?\??$/i,
  /\s+total\s+(?:goals|points|score)\b.*$/i,
  /\s+match\s+end\s+in\s+a\s+draw\??$/i,
  /\s+end\s+in\s+a\s+draw\??$/i,
  /\s+to\s+end\s+in\s+a\s+draw\??$/i,
  /\s+moneyline\b.*$/i,
  /\s+O\/U\s+[\d.]+\b.*$/i,
  /\s+over\/under\b.*$/i,
  /\s+over\s+[\d.]+\s+runs?\b.*$/i,
  /\s+under\s+[\d.]+\s+runs?\b.*$/i,
  /\s+wins?\s+by\s+over\s+[\d.]+\s+runs?\b.*$/i,
  /\bspread\s*:\s*.*$/i,
  /\s+\(-?\d+\.5\)\s*$/i,
  /\s+spread\b.*$/i,
  /\s+handicap\b.*$/i,
  /**
   * Kalshi-style colon-suffix buckets (phase G bugfix 2026-04-19): "... : First Half Winner?",
   * "... : Quarterfinal match", "... : 1st Half", etc. Everything from the last space-colon
   * onward is a market-type bucket, not part of a team name.
   */
  /\s*:\s*first\s+half\b.*$/i,
  /\s*:\s*second\s+half\b.*$/i,
  /\s*:\s*1st\s+half\b.*$/i,
  /\s*:\s*2nd\s+half\b.*$/i,
  /\s*:\s*(?:1st|2nd|3rd|4th)\s+quarter\b.*$/i,
  /\s*:\s*first\s+quarter\b.*$/i,
  /\s*:\s*second\s+quarter\b.*$/i,
  /\s*:\s*third\s+quarter\b.*$/i,
  /\s*:\s*fourth\s+quarter\b.*$/i,
  /\s*:\s*quarterfinals?\b.*$/i,
  /\s*:\s*semifinals?\b.*$/i,
  /\s*:\s*final\b.*$/i,
  /\s*:\s*round\s+of\s+\d+\b.*$/i,
  /\s*:\s*first\s+\d+\s+innings?\b.*$/i,
  /\s*:\s*first\s+inning\b.*$/i,
  /\s*:\s*period\s+\d+\b.*$/i,
  /\s*:\s*set\s+\d+\b.*$/i,
  // Do not use `winner.*$` — it matches mid-title "Team Winner? vs …" and deletes the matchup.
  /\s+winner\??$/i,
  /\s+runs\??$/i,
  /\?\s*$/,
];

const MATCHUP_SPLIT_RE =
  /^(.+?)\s+(?:vs\.?|@|at(?!\s+(?:least|most|once|all|any|the\b|a\b)))\s+(.+)$/i;

/** Strip junk tokens that appear *inside* a team segment (e.g. Kalshi "Miami Winner? vs Boston"). */
const TEAM_SEGMENT_STRIP_PATTERNS = [
  /\s+winner\??$/i,
  /\s+total\s+runs?\b.*$/i,
  /\s+runs\??$/i,
  /\s+moneyline\b.*$/i,
  /\s+spread\b.*$/i,
  /\s+O\/U\b.*$/i,
  /**
   * Colon-suffix market-type buckets surviving a pre-split miss (phase G bugfix 2026-04-19).
   * If any ":" appears inside a team segment and is followed by a known bucket phrase,
   * chop everything from the colon onward. Keep list synchronized with
   * TEAM_TITLE_SUFFIX_STRIP_PATTERNS above.
   */
  /\s*:\s*first\s+half\b.*$/i,
  /\s*:\s*second\s+half\b.*$/i,
  /\s*:\s*1st\s+half\b.*$/i,
  /\s*:\s*2nd\s+half\b.*$/i,
  /\s*:\s*(?:1st|2nd|3rd|4th)\s+quarter\b.*$/i,
  /\s*:\s*first\s+quarter\b.*$/i,
  /\s*:\s*second\s+quarter\b.*$/i,
  /\s*:\s*third\s+quarter\b.*$/i,
  /\s*:\s*fourth\s+quarter\b.*$/i,
  /\s*:\s*quarterfinals?\b.*$/i,
  /\s*:\s*semifinals?\b.*$/i,
  /\s*:\s*final\b.*$/i,
  /\s*:\s*round\s+of\s+\d+\b.*$/i,
  /\s*:\s*first\s+\d+\s+innings?\b.*$/i,
  /\s*:\s*first\s+inning\b.*$/i,
  /\s*:\s*period\s+\d+\b.*$/i,
  /\s*:\s*set\s+\d+\b.*$/i,
  /\s*:\s*[A-Za-z][A-Za-z0-9 .\-']{2,}\s*match\??\s*$/i,
];

/**
 * Remove prop/market-type fragments from a single side of a matchup (after vs/at split).
 * @param {string} segment
 * @returns {string}
 */
export function sanitizeExtractedTeamSegment(segment) {
  let s = String(segment || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  const maxPasses = 12;
  for (let pass = 0; pass < maxPasses; pass++) {
    let before = s;
    for (const re of TEAM_SEGMENT_STRIP_PATTERNS) {
      const m = s.match(re);
      if (m != null && m.index != null && m.index >= 0) {
        s = s.slice(0, m.index).trim();
      }
    }
    s = s.replace(/^[?.:;,]+|[?.:;,]+$/g, "").trim();
    if (s === before) break;
  }
  return s.slice(0, 100);
}

/**
 * Remove known market-type / prop suffixes from the end of a title so team parsing sees only matchup text.
 * @param {string} title
 * @returns {string}
 */
export function stripSportsMarketTypeSuffixForTeamTitle(title) {
  let s = String(title || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  const maxPasses = 24;
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    for (const re of TEAM_TITLE_SUFFIX_STRIP_PATTERNS) {
      const m = s.match(re);
      if (m && m.index != null && m.index > 0) {
        s = s.slice(0, m.index).trim();
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return s.replace(/[?:.,;]+$/g, "").trim();
}

/**
 * @param {string} cleaned — output of stripSportsMarketTypeSuffixForTeamTitle (or equivalent)
 * @returns {{ homeTeam: string | null, awayTeam: string | null }}
 */
export function parseMatchupTeamsFromCleanedTitle(cleaned) {
  let s = String(cleaned || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return { homeTeam: null, awayTeam: null };

  const willM = s.match(/^will\s+(.+)/i);
  if (willM) {
    // Phase G bugfix 2026-04-19: "Will <player> win the <A> vs <B> : <round>" is a
    // propositional market, not a matchup. If the post-"will" substring contains "win the"
    // followed by a vs/at split, reject — teams would otherwise come out as
    // "<player> win the <A>" vs "<B>".
    if (/\bwin(?:s)?\s+the\b/i.test(willM[1])) return { homeTeam: null, awayTeam: null };
    s = willM[1].trim();
  }

  const m = s.match(MATCHUP_SPLIT_RE);
  if (!m) return { homeTeam: null, awayTeam: null };

  let away = sanitizeExtractedTeamSegment(m[1].trim().replace(/^[?.:;,]+|[?.:;,]+$/g, "").trim());
  let home = sanitizeExtractedTeamSegment(m[2].trim().replace(/^[?.:;,]+|[?.:;,]+$/g, "").trim());
  if (!away || !home) return { homeTeam: null, awayTeam: null };

  return {
    homeTeam: home,
    awayTeam: away,
  };
}

/**
 * Strip market-type suffix (classifier-aligned), then split on vs / @ / at for home/away.
 * Returns null teams if the title does not look like a head-to-head matchup.
 * @param {string} title
 * @returns {{ homeTeam: string | null, awayTeam: string | null }}
 */
export function extractSportsMatchupTeamsFromTitle(title) {
  const raw = String(title || "").trim();
  if (!raw) return { homeTeam: null, awayTeam: null };
  if (!looksLikeMatchupMarket({ title: raw })) return { homeTeam: null, awayTeam: null };
  const cleaned = stripSportsMarketTypeSuffixForTeamTitle(raw);
  return parseMatchupTeamsFromCleanedTitle(cleaned);
}
