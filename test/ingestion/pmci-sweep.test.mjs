import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sweepSource = readFileSync(
  join(__dirname, "../../lib/ingestion/pmci-sweep.mjs"),
  "utf8",
);

test("SQL_STALE_MARKETS includes 'active' status", () => {
  assert.match(
    sweepSource,
    /pm\.status\s+IN\s*\(\s*'open'\s*,\s*'active'\s*\)/,
    "Sweep query must match both 'open' and 'active' statuses",
  );
});

test("SQL_STALE_MARKETS still handles NULL status", () => {
  assert.match(
    sweepSource,
    /pm\.status\s+IS\s+NULL/,
    "Sweep query must still handle NULL status rows",
  );
});

test("SQL_STALE_MARKETS filters by 10-minute staleness window", () => {
  assert.match(
    sweepSource,
    /interval\s+'10 minutes'/,
    "Sweep query must use 10-minute staleness window",
  );
});
