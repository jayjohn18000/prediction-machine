-- Autovacuum tuning for pmci.provider_markets.
--
-- Audit 2026-04-24: this table had 20.6% dead tuples (22,815 / 110,731) with
-- the last autovacuum ~20h prior. The default thresholds (0.2 scale factor)
-- only wake autovacuum after ~22K updates on a 110K-row table — which matches
-- the lag we're seeing given 1.2M INSERTs and 112K embedding UPDATEs in
-- recent history.
--
-- Tightening the scale factors fires autovacuum more often, keeping heap +
-- index pages lean and reducing the amount of dead data the critical
-- provider-markets lookups (16.7M pk scans, 43K provider-id scans) have to
-- wade through.

ALTER TABLE pmci.provider_markets SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_limit = 1000
);
