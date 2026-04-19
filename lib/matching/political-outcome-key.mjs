/**
 * Normalize per-candidate / per-person labels for politics template_params.outcome_key (Phase G Phase 2).
 * Keeps Kalshi "… — Katie Britt" and Polymarket metadata.outcome_name aligned when possible.
 */

const HONORIFIC_RE =
  /\b(sen(?:ator)?|rep\.?|representative|president|pres\.?|gov(?:ernor)?|mr\.?|mrs\.?|ms\.?|dr\.?)\b\.?/gi;

const OUTCOME_STOP = new Set([
  "who",
  "what",
  "which",
  "will",
  "the",
  "a",
  "an",
  "win",
  "wins",
  "candidate",
  "option",
  "person",
  "yes",
  "no",
]);

/**
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizePoliticalPersonKey(raw) {
  let s = String(raw || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(HONORIFIC_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  const parts = s.split(" ").filter((t) => t.length > 0 && !OUTCOME_STOP.has(t));
  if (parts.length === 0) return null;
  return parts.join("_").slice(0, 120);
}

/**
 * @param {{ title?: string, provider_market_ref?: string, metadata?: Record<string, unknown> }} market
 * @returns {string | null}
 */
export function extractPoliticalOutcomeKey(market) {
  const meta = market?.metadata;
  const on = meta && typeof meta === "object" ? meta.outcome_name : null;
  if (typeof on === "string" && on.trim()) {
    const k = normalizePoliticalPersonKey(on.replace(/\?+$/, ""));
    if (k) return k;
  }

  const title = String(market?.title || "").trim();
  if (!title) return null;

  const dashed = title.split(/\s+[—–-]\s+/).map((p) => p.trim()).filter(Boolean);
  if (dashed.length >= 2) {
    const tail = dashed[dashed.length - 1].replace(/\?+$/g, "").trim();
    if (
      tail.length >= 3 &&
      tail.length < 120 &&
      !/^\d+$/.test(tail) &&
      !/\b202[468]\b/.test(tail) &&
      !/^who\b/i.test(tail)
    ) {
      const k = normalizePoliticalPersonKey(tail);
      if (k) return k;
    }
  }

  const m =
    title.match(/\bnominee\s+20\d{2}\s*:\s*(.+)/i) ||
    title.match(/\bcandidate:\s*(.+)/i) ||
    title.match(/\bfor\s+president[^:?]*[:\-]\s*(.+)/i);
  if (m?.[1]) {
    const k = normalizePoliticalPersonKey(m[1].replace(/\?+$/, ""));
    if (k) return k;
  }

  return null;
}

/**
 * Whether this politics market should receive outcome_key (nominee / primary style pools).
 * @param {string} topicKey from extractTopicKey
 * @param {string} combined title + ref lowercased
 */
export function shouldAttachPoliticalOutcomeKey(topicKey, combined) {
  if (topicKey === "nominee") return true;
  return /\b(nominee|primary|presidential|2028)\b/i.test(combined);
}
