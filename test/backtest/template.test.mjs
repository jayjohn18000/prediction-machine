import test from "node:test";
import assert from "node:assert/strict";
import { templateOf, normalizeSport, SPORT_ALIASES } from "../../lib/backtest/template.mjs";

test("normalizeSport: MLB, Major League Baseball, mlb all map to 'mlb'", () => {
  assert.equal(normalizeSport("MLB"), "mlb");
  assert.equal(normalizeSport("mlb"), "mlb");
  assert.equal(normalizeSport("Major League Baseball"), "mlb");
  assert.equal(normalizeSport("baseball"), "mlb");
});

test("normalizeSport: NHL aliases", () => {
  assert.equal(normalizeSport("NHL"), "nhl");
  assert.equal(normalizeSport("Hockey"), "nhl");
  assert.equal(normalizeSport("National Hockey League"), "nhl");
});

test("normalizeSport: soccer aliases", () => {
  assert.equal(normalizeSport("Soccer"), "soccer");
  assert.equal(normalizeSport("football"), "soccer");
  assert.equal(normalizeSport("EPL"), "soccer");
});

test("normalizeSport: cricket → null (not in alias map)", () => {
  assert.equal(normalizeSport("cricket"), null);
});

test("normalizeSport: null / empty / whitespace → null", () => {
  assert.equal(normalizeSport(null), null);
  assert.equal(normalizeSport(undefined), null);
  assert.equal(normalizeSport(""), null);
  assert.equal(normalizeSport("   "), null);
});

test("templateOf: sports + mlb → sports.mlb template, include_in_scoreboard=true", () => {
  const t = templateOf({ category: "sports", sport: "mlb" });
  assert.equal(t.template_id, "sports.mlb.kalshi-polymarket");
  assert.equal(t.include_in_scoreboard, true);
  assert.equal(t.category, "sports");
});

test("templateOf: sports + nhl", () => {
  const t = templateOf({ category: "sports", sport: "NHL" });
  assert.equal(t.template_id, "sports.nhl.kalshi-polymarket");
  assert.equal(t.include_in_scoreboard, true);
});

test("templateOf: sports + soccer", () => {
  const t = templateOf({ category: "sports", sport: "soccer" });
  assert.equal(t.template_id, "sports.soccer.kalshi-polymarket");
  assert.equal(t.include_in_scoreboard, true);
});

test("templateOf: sports + unknown sport → sports.unknown, not scored", () => {
  const t = templateOf({ category: "sports", sport: "cricket" });
  assert.equal(t.template_id, "sports.unknown.kalshi-polymarket");
  assert.equal(t.include_in_scoreboard, false);
});

test("templateOf: non-sports category → audit-only, not scored", () => {
  // Politics rows have polluted category strings — this must not crash.
  const t = templateOf({ category: "democratic-presidential-nominee-2028" });
  assert.equal(t.template_id, "audit-only");
  assert.equal(t.include_in_scoreboard, false);
  assert.equal(t.category, "democratic-presidential-nominee-2028");
});

test("templateOf: politics category → audit-only", () => {
  const t = templateOf({ category: "politics" });
  assert.equal(t.template_id, "audit-only");
  assert.equal(t.include_in_scoreboard, false);
});

test("templateOf: prefers k_sport, then p_sport, then sport", () => {
  assert.equal(
    templateOf({ category: "sports", k_sport: "MLB", p_sport: "soccer", sport: "nhl" }).template_id,
    "sports.mlb.kalshi-polymarket",
  );
  assert.equal(
    templateOf({ category: "sports", k_sport: null, p_sport: "soccer", sport: "nhl" }).template_id,
    "sports.soccer.kalshi-polymarket",
  );
  assert.equal(
    templateOf({ category: "sports", k_sport: null, p_sport: null, sport: "nhl" }).template_id,
    "sports.nhl.kalshi-polymarket",
  );
});

test("templateOf: sports category with no sport provided → sports.unknown", () => {
  const t = templateOf({ category: "sports" });
  assert.equal(t.template_id, "sports.unknown.kalshi-polymarket");
  assert.equal(t.include_in_scoreboard, false);
});

test("SPORT_ALIASES: each canonical key maps to itself", () => {
  for (const canonical of Object.keys(SPORT_ALIASES)) {
    assert.equal(normalizeSport(canonical), canonical);
  }
});
