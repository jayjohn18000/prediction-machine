/**
 * Template + sport alias map for the A5 backtest scoreboard.
 *
 * `templateOf(fam)` returns metadata that gets stamped onto every FixtureRow.
 * Only known sports templates roll up to the scoreboard; unknown sports and
 * non-sports categories pass through as audit-only.
 *
 * @typedef {import('./types.mjs').Template} Template
 */

/**
 * Canonical sport id → alias list. Aliases are matched case-insensitive after
 * stripping to alphanumeric lowercase. For v1, each canonical maps to itself
 * plus a small set of plausible future labels; the identity match covers all
 * current data. The indirection earns its keep when a future provider arrives
 * with divergent labels (e.g., "Major League Baseball" vs "MLB").
 */
export const SPORT_ALIASES = {
  mlb: ["mlb", "baseball", "majorleaguebaseball"],
  nhl: ["nhl", "hockey", "nationalhockeyleague"],
  soccer: ["soccer", "football", "fifa", "epl", "mls", "uefa", "laliga"],
};

const _ALIAS_INDEX = (() => {
  const idx = new Map();
  for (const [canonical, aliases] of Object.entries(SPORT_ALIASES)) {
    for (const alias of aliases) {
      idx.set(alias, canonical);
    }
  }
  return idx;
})();

/**
 * Strip to lowercase alphanumeric, look up in the alias index, return canonical
 * sport id or null if no match.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
export function normalizeSport(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!s) return null;
  return _ALIAS_INDEX.get(s) ?? null;
}

const SPORT_DISPLAY = {
  mlb: "MLB",
  nhl: "NHL",
  soccer: "Soccer",
};

/**
 * Return template metadata for a family.
 *
 * Sports-only on the scoreboard. Non-sports categories get an 'audit-only'
 * template and `include_in_scoreboard: false`. Politics categories may carry
 * Polymarket event slugs (e.g. 'democratic-presidential-nominee-2028') — the
 * function passes those through without crashing; they still route to
 * 'audit-only'.
 *
 * Reads sport preference order: fam.k_sport → fam.p_sport → fam.sport. Both
 * legs always agree on sport in the current data; the ordering is defensive.
 *
 * @param {object} fam - Family-shaped object. Must include `category`.
 *                        Optional sport fields: `sport`, `k_sport`, `p_sport`.
 * @returns {Template}
 */
export function templateOf(fam) {
  const category = fam?.category ?? "";
  const rawSport = fam?.k_sport ?? fam?.p_sport ?? fam?.sport ?? null;
  const canonical = normalizeSport(rawSport);

  if (category === "sports") {
    if (canonical) {
      return {
        template_id: `sports.${canonical}.kalshi-polymarket`,
        template_label: `Sports — ${SPORT_DISPLAY[canonical] ?? canonical.toUpperCase()} (kalshi/polymarket)`,
        category: "sports",
        include_in_scoreboard: true,
      };
    }
    return {
      template_id: "sports.unknown.kalshi-polymarket",
      template_label: "Sports — Unknown (kalshi/polymarket)",
      category: "sports",
      include_in_scoreboard: false,
    };
  }

  return {
    template_id: "audit-only",
    template_label: "Audit-only — non-sports",
    category: String(category || ""),
    include_in_scoreboard: false,
  };
}
