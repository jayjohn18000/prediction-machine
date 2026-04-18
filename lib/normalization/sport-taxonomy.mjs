/**
 * Phase G: Polymarket sport code → canonical sport namespace.
 * Opaque codes (e.g. itsb) require title-based inference via inferSportFromKalshiTicker patterns.
 */

/** @type {Record<string, string | null>} null = junk-drawer; infer from title */
export const POLY_SPORT_ALIAS = {
  wwoh: "nhl",
  bkfibaqeu: "nba",
  basketball: "nba",
  bkjpn: "basketball_jpn",
  bkaba: "basketball_aba",
  bkbbl: "basketball_bbl",
  bkbsl: "basketball_bsl",
  bkvtb: "basketball_vtb",
  bkgr1: "basketball_greece",
  euroleague: "euroleague",
  "j1-100": "soccer_j1",
  "j2-100": "soccer_j2",
  ukr1: "soccer_ukraine",
  cricipl: "cricket_ipl",
  cricpsl: "cricket_psl",
  cricket: "cricket",
  itsb: null,
};

/** Codes that must never appear on active rows after normalization + backfill */
export const POLY_OPAQUE_SPORT_CODES = new Set(
  Object.entries(POLY_SPORT_ALIAS)
    .filter(([, v]) => v !== null)
    .map(([k]) => k),
);

POLY_OPAQUE_SPORT_CODES.add("itsb");

/**
 * Map a single Polymarket tag slug (sport taxonomy code) to a canonical sport string, or null if opaque.
 * @param {string} rawSlug
 * @returns {string | null | undefined} undefined = not in alias table; null = infer from title
 */
export function mapPolymarketSportSlug(rawSlug) {
  if (rawSlug == null || typeof rawSlug !== "string") return undefined;
  const k = rawSlug.trim().toLowerCase();
  if (!k) return undefined;
  if (!Object.prototype.hasOwnProperty.call(POLY_SPORT_ALIAS, k)) return undefined;
  return POLY_SPORT_ALIAS[k];
}
