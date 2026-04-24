import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateByTemplate,
  medianLowerTiebreak,
  round2,
  round4,
} from "../../lib/backtest/aggregate.mjs";

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
    gross_dollars: 0,
    net_dollars: 0,
    hold_days: 5,
    cheap_costs_breakdown: null,
    exp_costs_breakdown: null,
    entry_threshold_used: 0.01,
    snapshot_interval_ms: 3600000,
    void_refund_model: "full_refund_v1",
    ...overrides,
  };
}

test("filter: skip rows are excluded from aggregation", () => {
  const rows = [
    mkRow({ family_id: "f1", net_dollars: 10 }),
    mkRow({ family_id: "f2", skip: "no_entry_found", net_dollars: null }),
    mkRow({ family_id: "f3", net_dollars: -5 }),
  ];
  const out = aggregateByTemplate(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].trades_simulated, 2);
});

test("filter: audit-only (include_in_scoreboard=false) rows are excluded", () => {
  const rows = [
    mkRow({ family_id: "f1", net_dollars: 10 }),
    mkRow({
      family_id: "f2",
      template_id: "audit-only",
      template_include_in_scoreboard: false,
      net_dollars: 200, // would blow up the mean if wrongly included
    }),
  ];
  const out = aggregateByTemplate(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].template_id, "sports.mlb.kalshi-polymarket");
  assert.equal(out[0].trades_simulated, 1);
});

test("win_rate, mean_net_edge, total_pnl: [+10, -5, +20] → 0.6667 / 8.33 / 25", () => {
  const rows = [
    mkRow({ family_id: "f1", net_dollars: 10 }),
    mkRow({ family_id: "f2", net_dollars: -5 }),
    mkRow({ family_id: "f3", net_dollars: 20 }),
  ];
  const out = aggregateByTemplate(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].trades_simulated, 3);
  assert.equal(out[0].win_rate, 0.6667);
  assert.equal(out[0].mean_net_edge_per_100, 8.33);
  assert.equal(out[0].total_pnl_history, 25);
});

test("disagreement_rate: both won + both lost count; won/lost does not", () => {
  const rows = [
    mkRow({ family_id: "f1", cheap_state: "won", exp_state: "won", net_dollars: 50 }),
    mkRow({ family_id: "f2", cheap_state: "lost", exp_state: "lost", net_dollars: -100 }),
    mkRow({ family_id: "f3", cheap_state: "won", exp_state: "lost", net_dollars: 5 }),
    mkRow({ family_id: "f4", cheap_state: "lost", exp_state: "won", net_dollars: 5 }),
  ];
  const out = aggregateByTemplate(rows);
  assert.equal(out[0].disagreement_rate, 0.5);
});

test("void_rate: any row with at least one void state counts", () => {
  const rows = [
    mkRow({ family_id: "f1", cheap_state: "void", exp_state: "lost", net_dollars: 0 }),
    mkRow({ family_id: "f2", cheap_state: "won", exp_state: "void", net_dollars: 0 }),
    mkRow({ family_id: "f3", cheap_state: "won", exp_state: "lost", net_dollars: 10 }),
  ];
  const out = aggregateByTemplate(rows);
  assert.equal(out[0].void_rate, round4(2 / 3));
});

test("sort order: total_pnl_history DESC, template_id ASC", () => {
  const rows = [
    // Template A: total = -5
    mkRow({
      family_id: "a1",
      template_id: "sports.mlb.kalshi-polymarket",
      template_label: "MLB",
      net_dollars: -5,
    }),
    // Template B: total = 15
    mkRow({
      family_id: "b1",
      template_id: "sports.nhl.kalshi-polymarket",
      template_label: "NHL",
      net_dollars: 15,
    }),
    // Template C: total = 15 (tie, should break alphabetically by template_id)
    mkRow({
      family_id: "c1",
      template_id: "sports.soccer.kalshi-polymarket",
      template_label: "Soccer",
      net_dollars: 15,
    }),
  ];
  const out = aggregateByTemplate(rows);
  assert.equal(out[0].total_pnl_history, 15);
  assert.equal(out[0].template_id, "sports.nhl.kalshi-polymarket");
  assert.equal(out[1].total_pnl_history, 15);
  assert.equal(out[1].template_id, "sports.soccer.kalshi-polymarket");
  assert.equal(out[2].total_pnl_history, -5);
});

test("median_hold_days: lower tiebreak with even N uses floor((n-1)/2)", () => {
  assert.equal(medianLowerTiebreak([1, 2, 3, 4]), 2); // idx floor((4-1)/2)=1
  assert.equal(medianLowerTiebreak([1, 2, 3, 4, 5]), 3); // idx 2 for odd N
  assert.equal(medianLowerTiebreak([10, 5, 2, 30]), 5); // sorted = [2,5,10,30], idx 1
});

test("median_hold_days: aggregator wires through", () => {
  const rows = [
    mkRow({ family_id: "f1", hold_days: 1, net_dollars: 1 }),
    mkRow({ family_id: "f2", hold_days: 2, net_dollars: 1 }),
    mkRow({ family_id: "f3", hold_days: 3, net_dollars: 1 }),
    mkRow({ family_id: "f4", hold_days: 4, net_dollars: 1 }),
  ];
  const out = aggregateByTemplate(rows);
  assert.equal(out[0].median_hold_days, 2);
});

test("resolution_equivalence: 'equivalent' when homogeneous, 'mixed' otherwise", () => {
  const rowsAllEquiv = [
    mkRow({ family_id: "f1", resolution_equivalence: "equivalent", net_dollars: 1 }),
    mkRow({ family_id: "f2", resolution_equivalence: "equivalent", net_dollars: 2 }),
  ];
  assert.equal(aggregateByTemplate(rowsAllEquiv)[0].resolution_equivalence, "equivalent");
  const rowsMixed = [
    mkRow({ family_id: "f1", resolution_equivalence: "equivalent", net_dollars: 1 }),
    mkRow({ family_id: "f2", resolution_equivalence: "ambiguous", net_dollars: 2 }),
  ];
  assert.equal(aggregateByTemplate(rowsMixed)[0].resolution_equivalence, "mixed");
});

test("rounding: round2 and round4 are deterministic per spec (Math.round(x*100)/100)", () => {
  // 1.005 * 100 in IEEE-754 is 100.49999...; Math.round → 100; /100 → 1.
  // This matches the documented implementation in the schema doc, chosen
  // specifically to avoid toFixed-based locale/precision drift.
  assert.equal(round2(1.005), 1);
  assert.equal(round2(1.004), 1);
  assert.equal(round2(1.234), 1.23);
  assert.equal(round2(1.236), 1.24);
  assert.equal(round4(0.66666666666), 0.6667);
});

test("empty input → empty output", () => {
  assert.deepEqual(aggregateByTemplate([]), []);
});

test("all skip rows → empty output", () => {
  const rows = [
    mkRow({ family_id: "f1", skip: "outcomes_missing" }),
    mkRow({ family_id: "f2", skip: "no_entry_found" }),
  ];
  assert.deepEqual(aggregateByTemplate(rows), []);
});
