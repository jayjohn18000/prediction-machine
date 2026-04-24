import test from "node:test";
import assert from "node:assert/strict";
import { kalshiLongYesPays, polyLongYesPays, extractOutcomeNameFromRef } from "../../lib/backtest/leg-payout.mjs";
import { loadEquivalenceCsv, defaultA3Path, parseCsvWithNewlinesInQuotes } from "../../lib/backtest/equivalence-csv.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

test("kalshi long yes from result yes", () => {
  assert.equal(kalshiLongYesPays({ winning_outcome: "yes" }), true);
  assert.equal(kalshiLongYesPays({ winning_outcome: "no" }), false);
});

test("poly long yes: outcome in ref (from pmci-sweep # convention)", () => {
  const row = {
    provider_market_ref: "0xabc#Athletics",
    title: "Game",
  };
  assert.equal(polyLongYesPays(row, "Athletics"), true);
  assert.equal(polyLongYesPays(row, "Yankees"), false);
});

test("A3 csv parses to table rows (quoted newlines) and default path exists", () => {
  const __d = path.dirname(fileURLToPath(import.meta.url));
  const a3 = defaultA3Path(path.join(__d, "../.."));
  const raw = fs.readFileSync(a3, "utf8");
  const t = parseCsvWithNewlinesInQuotes(raw);
  assert.ok(t.length >= 2);
  assert.equal(t[0][0], "family_id");
  const { byFamily, warnings } = loadEquivalenceCsv(a3, { allowAmbiguous: true, excludeFamilyIds: new Set() });
  assert.equal(warnings.length, 0, warnings.join(","));
  assert.ok(byFamily.size >= 100);
  const eOnly = loadEquivalenceCsv(a3, { allowAmbiguous: false, excludeFamilyIds: new Set() });
  assert.equal(typeof eOnly.byFamily.size, "number", "A3 no-filter load returns a Map");
  assert.ok(eOnly.warnings.length > 0 || eOnly.byFamily.size > 0, "A3: warn if no equivalents, or have equivalent rows");
});
