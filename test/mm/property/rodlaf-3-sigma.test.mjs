import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sigmaEstimatorFromMidCentsSeries } from "../../../lib/mm/fair-value/avellaneda-stoikov.mjs";

const _d = dirname(fileURLToPath(import.meta.url));

test("rodlaf bug 3: sigma estimator in [0.05, 0.15] for synthetic and fixture", () => {
  const synth = [];
  for (let i = 0; i < 80; i++) synth.push(45 + 8 * Math.sin(i / 7));
  const s1 = sigmaEstimatorFromMidCentsSeries(synth);
  assert.ok(s1 >= 0.05 && s1 <= 0.15, `synthetic sigma=${s1}`);

  const csv = readFileSync(join(_d, "../fixtures/kalshi-mids-sample.csv"), "utf8");
  const mids = csv
    .split(/\r?\n/)
    .slice(1)
    .map((l) => Number(l.split(",")[0]?.trim()))
    .filter((x) => Number.isFinite(x));
  const s2 = sigmaEstimatorFromMidCentsSeries(mids);
  assert.ok(s2 >= 0.05 && s2 <= 0.15, `fixture sigma=${s2}`);
});
