import test from "node:test";
import assert from "node:assert/strict";
import { mapPolymarketSportSlug } from "../../lib/normalization/sport-taxonomy.mjs";
import {
  resolvePolymarketSport,
  inferSportFromPolymarketTitle,
} from "../../lib/ingestion/services/sport-inference.mjs";
import {
  classifyPhaseGSportsMarketType,
  extractSportsMatchupTeamsFromTitle,
  stripSportsMarketTypeSuffixForTeamTitle,
} from "../../lib/normalization/market-type-classifier.mjs";

test("mapPolymarketSportSlug maps opaque codes", () => {
  assert.equal(mapPolymarketSportSlug("wwoh"), "nhl");
  assert.equal(mapPolymarketSportSlug("bkfibaqeu"), "nba");
  assert.equal(mapPolymarketSportSlug("itsb"), null);
});

test("resolvePolymarketSport expands wwoh before tag map", () => {
  assert.equal(resolvePolymarketSport(["wwoh"], "ignored"), "nhl");
});

test("resolvePolymarketSport uses title when itsb only", () => {
  assert.equal(
    resolvePolymarketSport(["itsb"], "Will Boston win the 2026 NBA Finals?"),
    "nba",
  );
});

test("inferSportFromPolymarketTitle matches docs alias", () => {
  assert.equal(inferSportFromPolymarketTitle("NBA game", ["nba"]), "nba");
});

test("classifyPhaseGSportsMarketType maps to vocabulary templates", () => {
  const m = classifyPhaseGSportsMarketType("A's vs NYM Winner?");
  assert.ok(m);
  assert.equal(m.template, "sports-moneyline");
  const t = classifyPhaseGSportsMarketType("Spread: Yankees (-1.5)");
  assert.ok(t);
  assert.equal(t.template, "sports-spread");
});

test("stripSportsMarketTypeSuffixForTeamTitle removes prop tails before team split", () => {
  assert.equal(
    stripSportsMarketTypeSuffixForTeamTitle("A's vs New York M first 5 innings runs?"),
    "A's vs New York M",
  );
});

test("extractSportsMatchupTeamsFromTitle strips market type then parses vs", () => {
  const t = extractSportsMatchupTeamsFromTitle("A's vs New York M first 5 innings runs?");
  assert.equal(t.awayTeam, "A's");
  assert.equal(t.homeTeam, "New York M");
  const w = extractSportsMatchupTeamsFromTitle("Athletics vs. New York Yankees Winner?");
  assert.equal(w.awayTeam, "Athletics");
  assert.equal(w.homeTeam, "New York Yankees");
});

test("extractSportsMatchupTeamsFromTitle cleans Winner? inside a team segment", () => {
  const u = extractSportsMatchupTeamsFromTitle("Miami Winner? vs Boston Winner?");
  assert.equal(u.awayTeam, "Miami");
  assert.equal(u.homeTeam, "Boston");
});
