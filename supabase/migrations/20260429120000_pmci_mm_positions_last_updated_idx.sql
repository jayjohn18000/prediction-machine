-- Additive: index for dashboards / freshness checks on position rollups (Workstream A MM triage).
CREATE INDEX IF NOT EXISTS idx_mm_positions_last_updated
  ON pmci.mm_positions (last_updated DESC);
