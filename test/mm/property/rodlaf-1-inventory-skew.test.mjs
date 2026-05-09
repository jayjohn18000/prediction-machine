import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { reservationPriceCents } from "../../../lib/mm/fair-value/avellaneda-stoikov.mjs";

const _d = dirname(fileURLToPath(import.meta.url));

test("rodlaf bug 1: inventory skew sign vs mid", () => {
  const mid = 50;
  const gamma = 0.1;
  const sigma = 0.1;
  const tau = 0.25;
  const rpLong = reservationPriceCents(mid, 10, gamma, sigma, tau);
  const rpShort = reservationPriceCents(mid, -10, gamma, sigma, tau);
  assert.ok(Number.isFinite(rpLong) && Number.isFinite(rpShort));
  assert.ok(rpLong < mid, `long YES should shift reservation below mid, got ${rpLong}`);
  assert.ok(rpShort > mid, `short YES should shift reservation above mid, got ${rpShort}`);
});

test("rodlaf bug 1: fixture mid series stable", () => {
  const csv = readFileSync(join(_d, "../fixtures/kalshi-mids-sample.csv"), "utf8");
  const mids = csv
    .split(/\r?\n/)
    .slice(1)
    .map((l) => {
      const cell = l.split(",")[0]?.trim();
      return Number(cell);
    })
    .filter((x) => Number.isFinite(x));
  assert.ok(mids.length >= 3);
  const m = mids[Math.floor(mids.length / 2)];
  const r = reservationPriceCents(m, 10, 0.1, 0.1, 0.2);
  assert.ok(r < m);
});
