/**
 * Phase G: Polymarket title → coarse market type + PMCI sports template keys.
 * Output templates align with lib/matching/sports-helpers.mjs SPORTS_BUCKET_TO_TEMPLATE.
 */

import { SPORTS_BUCKET_TO_TEMPLATE } from "../matching/sports-helpers.mjs";

/**
 * Ordered patterns: first match wins. Buckets match sports-helpers classifyMarketTypeBucket names.
 */
const PHASE_G_SPORTS_PATTERNS = [
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
 * @param {string} title
 * @returns {{ template: string, params: Record<string, unknown> } | null}
 */
export function classifyPhaseGSportsMarketType(title) {
  const t = String(title || "");
  if (!t.trim()) return null;
  for (const { bucket, pattern } of PHASE_G_SPORTS_PATTERNS) {
    if (!pattern.test(t)) continue;
    const template = SPORTS_BUCKET_TO_TEMPLATE[bucket];
    if (!template) continue;
    return {
      template,
      params: { bucket, source: "phase_g_market_type_classifier" },
    };
  }
  return null;
}
