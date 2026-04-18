import test from "node:test";
import assert from "node:assert/strict";
import { mapPolymarketSportSlug } from "../../lib/normalization/sport-taxonomy.mjs";
import {
  resolvePolymarketSport,
  inferSportFromPolymarketTitle,
} from "../../lib/ingestion/services/sport-inference.mjs";
import { classifyPhaseGSportsMarketType } from "../../lib/normalization/market-type-classifier.mjs";

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
