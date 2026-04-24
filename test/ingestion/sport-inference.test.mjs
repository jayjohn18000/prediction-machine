import test from "node:test";
import assert from "node:assert/strict";
import {
  POLYMARKET_SPORT_CLASSIFIER_VERSION,
  POLYMARKET_TAG_ID_MAP,
  POLYMARKET_EVENT_REF_PREFIX_MAP,
  SOCCER_LEAGUE_SLUGS,
  inferSportFromPolymarketTagId,
  inferSportFromPolymarketSlugOrTitle,
  resolvePolymarketSport,
  inferSportFromKalshiTicker,
} from "../../lib/ingestion/services/sport-inference.mjs";

// ─────────────────────────────────────────────────────────
// Classifier version stamp
// ─────────────────────────────────────────────────────────
test("POLYMARKET_SPORT_CLASSIFIER_VERSION is bumped for v2-h2h", () => {
  assert.equal(POLYMARKET_SPORT_CLASSIFIER_VERSION, "v2-h2h");
});

// ─────────────────────────────────────────────────────────
// Numeric tag_id map
// ─────────────────────────────────────────────────────────
test("tag_id 100100 (MLS) → soccer", () => {
  assert.equal(POLYMARKET_TAG_ID_MAP.get("100100"), "soccer");
});

test("tag_id 100088 (NHL) → nhl", () => {
  assert.equal(POLYMARKET_TAG_ID_MAP.get("100088"), "nhl");
});

test("tag_id 678 (MLB) → mlb", () => {
  assert.equal(POLYMARKET_TAG_ID_MAP.get("678"), "mlb");
});

test("tag_id 450 (NFL) → nfl", () => {
  assert.equal(POLYMARKET_TAG_ID_MAP.get("450"), "nfl");
});

test("tag_id 28 (NBA) → nba", () => {
  assert.equal(POLYMARKET_TAG_ID_MAP.get("28"), "nba");
});

test("tag_id 102650 (Saudi Pro League) → soccer", () => {
  assert.equal(POLYMARKET_TAG_ID_MAP.get("102650"), "soccer");
});

test("tag_id 102649 (J1 League) → soccer", () => {
  assert.equal(POLYMARKET_TAG_ID_MAP.get("102649"), "soccer");
});

test("tag_id 102770 (J2 League) → soccer", () => {
  assert.equal(POLYMARKET_TAG_ID_MAP.get("102770"), "soccer");
});

test("tag_id 102561 (Argentine Primera) → soccer", () => {
  assert.equal(POLYMARKET_TAG_ID_MAP.get("102561"), "soccer");
});

test("tag_id=1 (generic 'Sports' parent) is intentionally NOT mapped", () => {
  // Generic parents would cause false positives — classifier must defer to title/slug.
  assert.equal(POLYMARKET_TAG_ID_MAP.has("1"), false);
});

test("inferSportFromPolymarketTagId picks up ctx tag_id", () => {
  assert.equal(inferSportFromPolymarketTagId([], "100100"), "soccer");
  assert.equal(inferSportFromPolymarketTagId([], "100088"), "nhl");
});

test("inferSportFromPolymarketTagId ignores unknown numeric ids", () => {
  assert.equal(inferSportFromPolymarketTagId([], "99999999"), "unknown");
});

test("inferSportFromPolymarketTagId scans tag_bits for numeric strings", () => {
  // When tag_slug is numeric, like "128"/"100350", mapping still succeeds.
  assert.equal(inferSportFromPolymarketTagId(["100100"], null), "soccer");
  assert.equal(inferSportFromPolymarketTagId(["foo", "bar", "678"], null), "mlb");
});

// ─────────────────────────────────────────────────────────
// event_ref prefix fallback
// ─────────────────────────────────────────────────────────
test("event_ref prefix 'mls-' → soccer", () => {
  const out = inferSportFromPolymarketSlugOrTitle({
    event_ref: "mls-lag-rsl-2026-04-26-total-3pt5",
  });
  assert.equal(out, "soccer");
});

test("event_ref prefix 'spl-' (Saudi Pro League) → soccer", () => {
  const out = inferSportFromPolymarketSlugOrTitle({
    event_ref: "spl-nsr-ett-2026-04-24-draw",
  });
  assert.equal(out, "soccer");
});

test("event_ref prefix 'nhl-' → nhl", () => {
  const out = inferSportFromPolymarketSlugOrTitle({
    event_ref: "nhl-sj-wpg-2026-04-16-total-5pt5",
  });
  assert.equal(out, "nhl");
});

test("event_ref prefix 'mlb-' → mlb", () => {
  const out = inferSportFromPolymarketSlugOrTitle({
    event_ref: "mlb-mil-bos-2026-04-25",
  });
  assert.equal(out, "mlb");
});

test("event_ref prefix 'cdr-' (Copa del Rey) → soccer", () => {
  const out = inferSportFromPolymarketSlugOrTitle({
    event_ref: "cdr-atm-rso-2026-04-18-draw",
  });
  assert.equal(out, "soccer");
});

test("event_ref prefix 'j1100-' → soccer", () => {
  const out = inferSportFromPolymarketSlugOrTitle({
    event_ref: "j1100-san-vva-2026-04-18-total-2pt5",
  });
  assert.equal(out, "soccer");
});

// ─────────────────────────────────────────────────────────
// Slug / title fragment fallback — narrow by design
// ─────────────────────────────────────────────────────────
test("slug contains 'mls' → soccer", () => {
  const out = inferSportFromPolymarketSlugOrTitle({
    slug: "who-will-win-mls-match-2026-04-26",
  });
  assert.equal(out, "soccer");
});

test("title contains 'Premier League' → soccer", () => {
  const out = inferSportFromPolymarketSlugOrTitle({
    title: "Premier League: Arsenal vs. Liverpool",
  });
  assert.equal(out, "soccer");
});

test("title with niche non-league team names returns 'unknown'", () => {
  // Niche / unmapped teams MUST NOT get auto-classified — A3 equivalence would
  // catch false pairings but correctness matters upstream too.
  const out = inferSportFromPolymarketSlugOrTitle({
    title: "Ismaily SC vs. Modern SC",
  });
  assert.equal(out, "unknown");
});

test("empty context → 'unknown'", () => {
  assert.equal(inferSportFromPolymarketSlugOrTitle({}), "unknown");
});

// ─────────────────────────────────────────────────────────
// resolvePolymarketSport integration (the path the ingester actually calls)
// ─────────────────────────────────────────────────────────
test("resolvePolymarketSport: numeric tag_slug + tag_id=100100 → soccer", () => {
  const sport = resolvePolymarketSport(["33", "100100"], "Will X vs. Y end in a draw?", {
    tag_id: "100100",
    event_ref: "mls-lag-rsl-2026-04-26-draw",
  });
  assert.equal(sport, "soccer");
});

test("resolvePolymarketSport: Saudi-Club title + spl- event_ref → soccer", () => {
  const sport = resolvePolymarketSport(
    ["68", "102650"],
    "Will Al Nassr Saudi Club vs. Al Ettifaq Saudi Club end in a draw?",
    { tag_id: "102650", event_ref: "spl-nsr-ett-2026-04-24-draw" },
  );
  assert.equal(sport, "soccer");
});

test("resolvePolymarketSport: Argentine Primera → soccer", () => {
  const sport = resolvePolymarketSport(
    ["19", "102561"],
    "Will Gimnasia y Esgrima de La Plata vs. AA Estudiantes end in a draw?",
    { tag_id: "102561", event_ref: "arg-gim-aae-2026-04-18-draw" },
  );
  assert.equal(sport, "soccer");
});

test("resolvePolymarketSport: 'Sharks vs. Jets: O/U 5.5' with NHL tag_id → nhl", () => {
  const sport = resolvePolymarketSport(["131", "100088"], "Sharks vs. Jets: O/U 5.5", {
    tag_id: "100088",
    event_ref: "nhl-sj-wpg-2026-04-16-total-5pt5",
  });
  assert.equal(sport, "nhl");
});

test("resolvePolymarketSport: legacy tagBit-only path still resolves MLS", () => {
  // Backward-compat: no ctx provided; mls tag-bit alone should still match.
  const sport = resolvePolymarketSport(["mls"], "MLS: New York vs Chicago");
  assert.equal(sport, "soccer");
});

test("resolvePolymarketSport: genuinely unknown niche league stays 'unknown'", () => {
  // No tag_id match, no event_ref prefix match, no league fragment in title.
  const sport = resolvePolymarketSport(
    ["foo"],
    "Some Uncategorized Match: Team A vs Team B",
    { tag_id: "999999", event_ref: "xyz-abc-def-2026-04-18" },
  );
  assert.equal(sport, "unknown");
});

test("resolvePolymarketSport: opaque tag (junk drawer only) falls through to title/slug", () => {
  const sport = resolvePolymarketSport(["itsb"], "NWSL Match: Chicago vs Portland", {
    event_ref: "nwsl-chi-por-2026-04-18",
  });
  assert.equal(sport, "soccer");
});

// ─────────────────────────────────────────────────────────
// Map-level coverage sanity
// ─────────────────────────────────────────────────────────
test("POLYMARKET_EVENT_REF_PREFIX_MAP includes core leagues", () => {
  for (const p of ["mls", "nhl", "mlb", "spl", "cdr", "dfb", "ere", "bra", "j1100", "j2100"]) {
    assert.ok(POLYMARKET_EVENT_REF_PREFIX_MAP.has(p), `missing prefix: ${p}`);
  }
});

test("SOCCER_LEAGUE_SLUGS includes top-6 European leagues", () => {
  for (const frag of [
    "mls",
    "premier-league",
    "la-liga",
    "bundesliga",
    "serie-a",
    "ligue-1",
    "eredivisie",
  ]) {
    assert.ok(SOCCER_LEAGUE_SLUGS.includes(frag), `missing frag: ${frag}`);
  }
});

// ─────────────────────────────────────────────────────────
// Regression guard: no changes to Kalshi ticker inference.
// ─────────────────────────────────────────────────────────
test("Kalshi ticker inference unchanged: NHL title → nhl", () => {
  assert.equal(inferSportFromKalshiTicker("NHL Eastern Conference Winner"), "nhl");
});

test("Kalshi ticker inference unchanged: unknown title → unknown", () => {
  assert.equal(inferSportFromKalshiTicker("Who will win the Iditarod?"), "unknown");
});
