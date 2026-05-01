import test from "node:test";
import assert from "node:assert/strict";
import {
  serializeFixturesCsv,
  serializeTemplatesCsv,
} from "../../scripts/backtest/run-backtest.mjs";
import { aggregateByTemplate, round2 } from "../../lib/backtest/aggregate.mjs";

function mkRow(overrides = {}) {
  return {
    family_id: "f1",
    template_id: "sports.mlb.kalshi-polymarket",
    template_label: "Sports — MLB (kalshi/polymarket)",
    category: "sports",
    template_include_in_scoreboard: true,
    sport: "mlb",
    resolution_equivalence: "equivalent",
    skip: null,
    direction: "k_cheap",
    spread_at_entry: 0.05,
    cheap_state: "won",
    exp_state: "lost",
    gross_dollars: 10.235,
    net_dollars: 8.12,
    hold_days: 3,
    cheap_costs_breakdown: null,
    exp_costs_breakdown: null,
    entry_threshold_used: 0.01,
    snapshot_interval_ms: 3600000,
    void_refund_model: "full_refund_v1",
    ...overrides,
  };
}

test("fixtures CSV serializes byte-identically across two runs", () => {
  const rows = [
    mkRow({ family_id: "f1", net_dollars: 8.12 }),
    mkRow({
      family_id: "f2",
      template_id: "sports.nhl.kalshi-polymarket",
      template_label: "NHL",
      sport: "nhl",
      net_dollars: -2.5,
      cheap_state: "lost",
      exp_state: "won",
    }),
    mkRow({
      family_id: "f3",
      template_id: "audit-only",
      template_include_in_scoreboard: false,
      category: "democratic-presidential-nominee-2028",
      sport: null,
      net_dollars: null,
      gross_dollars: null,
      skip: "outcomes_missing",
      direction: null,
      cheap_state: null,
      exp_state: null,
      hold_days: null,
    }),
  ];
  const a = serializeFixturesCsv(rows);
  const b = serializeFixturesCsv(rows);
  assert.equal(a, b);
});

test("templates CSV serializes byte-identically across two runs (via aggregator)", () => {
  const rows = [
    mkRow({ family_id: "f1", net_dollars: 8.12, hold_days: 3 }),
    mkRow({ family_id: "f2", net_dollars: -2.5, hold_days: 5 }),
    mkRow({ family_id: "f3", net_dollars: 15.9, hold_days: 7 }),
  ];
  const agg1 = aggregateByTemplate(rows);
  const agg2 = aggregateByTemplate(rows);
  assert.equal(serializeTemplatesCsv(agg1), serializeTemplatesCsv(agg2));
});

test("fixtures CSV body contains no '#' comment lines", () => {
  const rows = [mkRow({ family_id: "f1" })];
  const csv = serializeFixturesCsv(rows);
  for (const line of csv.split("\n")) {
    assert.ok(!line.startsWith("#"), `Found comment line in CSV: ${line}`);
  }
});

test("templates CSV body contains no '#' comment lines", () => {
  const rows = [mkRow({ family_id: "f1", net_dollars: 5 })];
  const agg = aggregateByTemplate(rows);
  const csv = serializeTemplatesCsv(agg);
  for (const line of csv.split("\n")) {
    assert.ok(!line.startsWith("#"), `Found comment line in CSV: ${line}`);
  }
});

test("round2 produces a stable string representation", () => {
  // 1.005 * 100 is 100.49999... in IEEE-754; Math.round → 100; /100 → 1.
  // This is the documented behavior; don't rely on intuitive round-half-up.
  assert.equal(String(round2(1.005)), "1");
  assert.equal(String(round2(1.234)), "1.23");
  assert.equal(String(round2(1.236)), "1.24");
  // Edge: 0.1 + 0.2 → 0.30000000000000004, round2 → 0.3.
  assert.equal(String(round2(0.1 + 0.2)), "0.3");
});

test("fixtures CSV sort order: template_id ASC, family_id ASC (numeric-aware)", () => {
  const rows = [
    mkRow({ family_id: "10", template_id: "sports.nhl.kalshi-polymarket" }),
    mkRow({ family_id: "2", template_id: "sports.nhl.kalshi-polymarket" }),
    mkRow({ family_id: "5", template_id: "sports.mlb.kalshi-polymarket" }),
  ];
  const csv = serializeFixturesCsv(rows);
  const lines = csv.trim().split("\n");
  // header + 3 rows
  assert.equal(lines.length, 4);
  // Expect mlb first, then nhl; within nhl, family_id 2 before 10.
  assert.match(lines[1], /^5,sports\.mlb\./);
  assert.match(lines[2], /^2,sports\.nhl\./);
  assert.match(lines[3], /^10,sports\.nhl\./);
});

test("templates CSV sort order: total_pnl_history DESC, template_id ASC", () => {
  const rows = [
    mkRow({
      family_id: "a1",
      template_id: "sports.mlb.kalshi-polymarket",
      template_label: "MLB",
      net_dollars: -5,
    }),
    mkRow({
      family_id: "b1",
      template_id: "sports.nhl.kalshi-polymarket",
      template_label: "NHL",
      net_dollars: 15,
    }),
  ];
  const agg = aggregateByTemplate(rows);
  const csv = serializeTemplatesCsv(agg);
  const lines = csv.trim().split("\n");
  assert.match(lines[1], /^sports\.nhl\./);
  assert.match(lines[2], /^sports\.mlb\./);
});
