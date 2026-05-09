/**
 * Numeric feature columns per scanner lane (decay PSI/KS + logistic regression).
 * Mirrors Phase 0 DDL (`pmci.scanner_*_signals`).
 */

export const SCANNER_TABLE_BY_INEFFICIENCY = {
  informational_lag: "scanner_informational_lag_signals",
  structural: "scanner_structural_signals",
  behavioral: "scanner_behavioral_signals",
  analytical: "scanner_analytical_signals",
  capacity: "scanner_capacity_signals",
  resolution_rule: "scanner_resolution_rule_signals",
};

export const INFORMATIONAL_NUMERIC_FEATURES = [
  "signal_strength_cents",
  "period",
  "game_clock_seconds_remaining",
  "wpa_at_event",
  "wpa_percentile_30d",
  "pre_event_kalshi_mid",
  "post_event_kalshi_mid",
  "fair_wp_estimate",
  "divergence_at_t_plus_30s",
  "lag_ms",
];

export const STRUCTURAL_NUMERIC_FEATURES = [
  "signal_strength_cents",
  "trade_count",
  "realized_yield_pct",
  "microprice",
  "imbalance_ratio",
  "spread_cents",
  "momentum_signal",
  "confidence_score",
];

/** @param {string} tableName */
export function numericFeaturesForTable(tableName) {
  if (tableName === "scanner_structural_signals") return STRUCTURAL_NUMERIC_FEATURES;
  return INFORMATIONAL_NUMERIC_FEATURES;
}
