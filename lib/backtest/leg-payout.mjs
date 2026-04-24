/**
 * Intra-venue only: does a long-YES on this market win at resolution?
 * Kalshi: winning_outcome is lowercased result ("yes" | "no") from the API.
 * Polymarket: winning_outcome is the token label; compare to this row's outcome, not cross-venue.
 */
export function extractOutcomeNameFromRef(providerMarketRef) {
  const ref = String(providerMarketRef ?? "");
  const idx = ref.indexOf("#");
  return idx >= 0 ? ref.slice(idx + 1).trim() : "";
}

function norm(s) {
  if (s == null || s === "") return "";
  return String(s)
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} winningOutcome
 * @returns {boolean}
 */
export function kalshiLongYesPays({ winning_outcome: winningOutcome }) {
  return String(winningOutcome ?? "")
    .trim()
    .toLowerCase() === "yes";
}

/**
 * @param {object} row - provider_markets row (at least: provider_market_ref, title, home_team, away_team)
 * @param {string} winningOutcome
 */
export function polyLongYesPays(row, winningOutcome) {
  const w = norm(winningOutcome);
  if (!w || w === "unknown") return false;

  // Canonical Yes/No outcome — futures / championship / single-question markets
  // (e.g. "Will Bayern Munich win the 2025–26 Bundesliga?" → winning_outcome: "Yes").
  // Polymarket returns the literal "Yes"/"No" for these, same semantics as Kalshi.
  // Must be checked BEFORE ref/team fallbacks: for these markets, home_team/away_team
  // are null and provider_market_ref is a bare condition_id with no #outcome suffix,
  // so the fallbacks silently return false and a real "Yes" resolution gets misread
  // as "YES lost".
  if (w === "yes") return true;
  if (w === "no") return false;

  const fromRef = norm(extractOutcomeNameFromRef(row.provider_market_ref));
  if (fromRef) {
    return w === fromRef || w.includes(fromRef) || fromRef.includes(w);
  }

  const ht = row.home_team ? norm(row.home_team) : "";
  const at = row.away_team ? norm(row.away_team) : "";
  if (ht && w === ht) return true;
  if (at && w === at) return true;
  if (ht && (w.includes(ht) || ht.includes(w))) return true;
  if (at && (w.includes(at) || at.includes(w))) return true;

  const title = String(row.title ?? "");
  for (const side of [row.home_team, row.away_team].filter(Boolean)) {
    if (side && norm(title).startsWith(norm(side))) {
      if (w === norm(side) || w.includes(norm(side)) || norm(side).includes(w)) return true;
    }
  }

  return false;
}
