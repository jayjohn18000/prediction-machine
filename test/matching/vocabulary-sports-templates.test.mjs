import test from "node:test";
import assert from "node:assert/strict";
import { classifyVocabularyTemplate } from "../../lib/classification/vocabulary-market-template.mjs";

function sportsRow(title, extra = {}) {
  return { title, category: "sports", ...extra };
}

test("vocabulary: team run total → sports-total", () => {
  const r = classifyVocabularyTemplate(sportsRow("Will Minnesota score over 4.5 runs?"));
  assert.equal(r.market_template, "sports-total");
});

test("vocabulary: draft pick", () => {
  const r = classifyVocabularyTemplate(
    sportsRow("Who will be picked 9th in the Pro Football Draft?"),
  );
  assert.equal(r.market_template, "sports-draft-pick");
});

test("vocabulary: next team", () => {
  const r = classifyVocabularyTemplate(sportsRow("What will be Tyreek Hill's next team?"));
  assert.equal(r.market_template, "sports-next-team");
});

test("vocabulary: esports map prop", () => {
  const r = classifyVocabularyTemplate(sportsRow("Game 1: Any Player Quadra Kill?"));
  assert.equal(r.market_template, "sports-esports-event");
});

test("vocabulary: fight method", () => {
  const r = classifyVocabularyTemplate(sportsRow("Will the fight be won by submission?"));
  assert.equal(r.market_template, "sports-fight-method");
});

test("vocabulary: race finish", () => {
  const r = classifyVocabularyTemplate(sportsRow("Miami Grand Prix: Top 10 Finishers"));
  assert.equal(r.market_template, "sports-race-finish");
});

test("vocabulary: match draw", () => {
  const r = classifyVocabularyTemplate(sportsRow("Will the match end in a draw?"));
  assert.equal(r.market_template, "sports-match-draw");
});
