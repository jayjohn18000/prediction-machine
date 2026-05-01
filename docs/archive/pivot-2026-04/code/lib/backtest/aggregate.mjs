/**
 * Aggregate a `FixtureRow[]` array into per-template scoreboard rows. Only
 * fixtures that were traded (skip === null) AND belong to a template with
 * include_in_scoreboard === true roll up.
 *
 * @typedef {import('./types.mjs').FixtureRow} FixtureRow
 */

/**
 * @param {number} x
 * @returns {number}
 */
export function round2(x) {
  return Math.round(x * 100) / 100;
}

/**
 * @param {number} x
 * @returns {number}
 */
export function round4(x) {
  return Math.round(x * 10000) / 10000;
}

/**
 * Median with the lower tiebreak: for even-length arrays, the value at
 * Math.floor((n - 1) / 2) of the sorted array. Chosen for determinism over
 * the more common "average of middle two" definition, which would introduce
 * float-rounding drift across runs.
 *
 * @param {number[]} arr
 * @returns {number|null}
 */
export function medianLowerTiebreak(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) / 2);
  return sorted[idx];
}

/**
 * Aggregate `FixtureRow[]` into per-template scoreboard rows.
 *
 * Output columns (per success-rubric.md § "What the backtest produces"):
 *   template_id, template_label, category,
 *   trades_simulated, win_rate, mean_net_edge_per_100,
 *   total_pnl_history, median_hold_days,
 *   disagreement_rate, void_rate,
 *   resolution_equivalence
 *
 * Sort: total_pnl_history DESC, template_id ASC.
 *
 * @param {FixtureRow[]} fixtureRows
 * @returns {Array<object>}
 */
export function aggregateByTemplate(fixtureRows) {
  const traded = fixtureRows.filter(
    (r) => !r.skip && r.template_include_in_scoreboard === true,
  );
  /** @type {Map<string, FixtureRow[]>} */
  const groups = new Map();
  for (const r of traded) {
    const k = r.template_id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const out = [];
  for (const [templateId, rows] of groups) {
    const n = rows.length;
    let wins = 0;
    let sumNet = 0;
    let disagreementCount = 0;
    let voidCount = 0;
    const holdDays = [];
    const equivSet = new Set();
    let templateLabel = "";
    let category = "";
    for (const r of rows) {
      if (r.net_dollars != null && r.net_dollars > 0) wins += 1;
      sumNet += Number(r.net_dollars ?? 0);
      if (r.hold_days != null) holdDays.push(Number(r.hold_days));
      const bothWon = r.cheap_state === "won" && r.exp_state === "won";
      const bothLost = r.cheap_state === "lost" && r.exp_state === "lost";
      if (bothWon || bothLost) disagreementCount += 1;
      if (r.cheap_state === "void" || r.exp_state === "void") voidCount += 1;
      equivSet.add(r.resolution_equivalence);
      if (!templateLabel) templateLabel = r.template_label;
      if (!category) category = r.category;
    }
    out.push({
      template_id: templateId,
      template_label: templateLabel,
      category,
      trades_simulated: n,
      win_rate: round4(wins / n),
      mean_net_edge_per_100: round2(sumNet / n),
      total_pnl_history: round2(sumNet),
      median_hold_days: medianLowerTiebreak(holdDays) ?? 0,
      disagreement_rate: round4(disagreementCount / n),
      void_rate: round4(voidCount / n),
      resolution_equivalence: equivSet.size === 1 ? [...equivSet][0] : "mixed",
    });
  }

  out.sort((a, b) => {
    if (b.total_pnl_history !== a.total_pnl_history) {
      return b.total_pnl_history - a.total_pnl_history;
    }
    return String(a.template_id).localeCompare(String(b.template_id));
  });

  return out;
}
