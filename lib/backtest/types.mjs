/**
 * Shared JSDoc typedefs for the A5 backtest engine.
 *
 * This module intentionally contains no runtime code. It exists so that
 * Sub-agent A (trade construction) and Sub-agent B (templates + output)
 * agree on the FixtureRow shape without duplicating the type.
 *
 * Consumers reference the typedefs with:
 *   /** @typedef {import('./types.mjs').FixtureRow} FixtureRow *\/
 */

/**
 * A single fixture's row in the per-fixture audit CSV and the in-memory engine
 * output. One row is emitted per linked bilateral family, including rows that
 * were skipped (entry never triggered, outcomes missing, degenerate prices, or
 * not eligible for any scoreboard template).
 *
 * The `template_*` fields are stamped by `templateOf(fam)` (see template.mjs).
 * The `skip` field is `null` for traded rows and a short string code otherwise.
 * Trade-detail fields are `null` on skip rows; run-config stamp fields are
 * always populated so the audit CSV always shows the engine's effective config.
 *
 * @typedef {object} FixtureRow
 * @property {string}  family_id                      - Stable bilateral family id (text).
 * @property {string}  template_id                    - From templateOf(); 'sports.{sport}.kalshi-polymarket' | 'sports.unknown.kalshi-polymarket' | 'audit-only'.
 * @property {string}  template_label                 - Human-readable template label.
 * @property {string}  category                       - 'sports' or pass-through (may be polluted by Polymarket event slug).
 * @property {boolean} template_include_in_scoreboard - True only for known sports templates.
 * @property {string|null} sport                      - Canonical sport id ('mlb'|'nhl'|'soccer') or null for unknown/non-sports.
 * @property {string}  resolution_equivalence         - 'equivalent' (upstream-filtered by A3).
 *
 * --- skip semantics ---
 * @property {string|null} skip - null for traded rows; one of: 'no_entry_found' | 'outcomes_missing' | 'degenerate_prices' | 'not_eligible_no_template'.
 *
 * --- trade detail (null on skip rows) ---
 * @property {'k_cheap'|'p_cheap'|null} direction     - Which venue was cheap at entry.
 * @property {number|null} spread_at_entry            - |kYes - pYes| at entry, in 0–1 units.
 * @property {'won'|'lost'|'void'|null} cheap_state   - Cheap leg's resolution state.
 * @property {'won'|'lost'|'void'|null} exp_state     - Expensive leg's resolution state.
 * @property {number|null} gross_dollars              - Gross P&L before costs (USD, full precision).
 * @property {number|null} net_dollars                - Net P&L after costs and void refunds (USD, full precision).
 * @property {number|null} hold_days                  - Calendar days from entry to last leg resolution; integer (Math.ceil).
 * @property {object|null} cheap_costs_breakdown      - Output of estimateCost() for the cheap leg.
 * @property {object|null} exp_costs_breakdown        - Output of estimateCost() for the expensive leg.
 *
 * --- run config stamp (always populated, even on skip rows) ---
 * @property {number} entry_threshold_used            - The threshold this run used (e.g. 0.01 for $1/$100).
 * @property {number} snapshot_interval_ms            - Hourly = 3600000.
 * @property {string} void_refund_model               - 'full_refund_v1'.
 */

/**
 * Template metadata attached to each fixture row. Returned by `templateOf(fam)`.
 *
 * @typedef {object} Template
 * @property {string}  template_id
 * @property {string}  template_label
 * @property {string}  category
 * @property {boolean} include_in_scoreboard
 */

// No exports — pure JSDoc module.
export {};
