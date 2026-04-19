import test from "node:test";
import assert from "node:assert/strict";
import { classifyTemplate as classifyPolitics } from "../../lib/matching/templates/politics-templates.mjs";
import {
  extractPoliticalOutcomeKey,
  normalizePoliticalPersonKey,
} from "../../lib/matching/political-outcome-key.mjs";

test("normalizePoliticalPersonKey strips honorifics", () => {
  assert.equal(normalizePoliticalPersonKey("Senator Katie Britt"), "katie_britt");
});

test("extractPoliticalOutcomeKey reads metadata.outcome_name", () => {
  const k = extractPoliticalOutcomeKey({
    title: "Republican nominee 2028",
    metadata: { outcome_name: "Senator Katie Britt" },
  });
  assert.equal(k, "katie_britt");
});

test("politics classifyTemplate adds outcome_key for nominee dash tail", () => {
  const hit = classifyPolitics({
    title: "Republican nominee 2028 — Katie Britt",
    provider_market_ref: "PREZ-28-X",
    category: "politics",
  });
  assert.ok(hit);
  assert.equal(hit.template, "politics-nominee");
  assert.equal(hit.params.topic_key, "nominee");
  assert.equal(hit.params.outcome_key, "katie_britt");
});

test("politics classifyTemplate adds outcome_key from metadata under nominee scope", () => {
  const hit = classifyPolitics({
    title: "Republican nominee 2028",
    provider_market_ref: "slug#katie-britt",
    category: "politics",
    metadata: { outcome_name: "Katie Britt" },
  });
  assert.ok(hit);
  assert.equal(hit.params.outcome_key, "katie_britt");
});
