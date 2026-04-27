-- Drop pmci.providers.last_snapshot_at and pmci.pmci_runtime_status.
-- Health endpoints live-compute against truth tables (per audit Group F1,
-- roadmap §2 row 5, agent 07 R1/R2, agent 01 R3, roadmap §6 OQ #6 resolved YES).
-- Live-compute is feasible because 20260424120003 tuned autovacuum on the
-- relevant tables.

ALTER TABLE pmci.providers DROP COLUMN IF EXISTS last_snapshot_at;
DROP TABLE IF EXISTS pmci.pmci_runtime_status;

DROP FUNCTION IF EXISTS pmci.update_runtime_status();
