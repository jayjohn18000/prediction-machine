-- Drop indexes flagged as unused (0 scans) by the Supabase performance linter.
-- Audit 2026-04-24: these indexes account for roughly 2.35 GB of disk (of a
-- 7.7 GB DB) and add write overhead on every INSERT/UPDATE to their tables.
--
-- Biggest offenders:
--   idx_pmci_provider_markets_embedding            2173 MB  (ivfflat/hnsw vector index, 0 scans)
--   idx_prediction_market_spreads_candidate_...     118 MB
--   idx_prediction_market_spreads_event_id_...       37 MB
--
-- Pivot A1 table indexes (market_outcomes, market_outcome_history) are
-- intentionally NOT dropped here — the backtest engine (A5) is still being
-- built and will start scanning them.

DROP INDEX IF EXISTS pmci.idx_pmci_provider_markets_embedding;

DROP INDEX IF EXISTS public.idx_prediction_market_spreads_candidate_observed_at;
DROP INDEX IF EXISTS public.idx_prediction_market_spreads_event_id_observed_at;

DROP INDEX IF EXISTS public.idx_execution_signal_quality_execution_score;
DROP INDEX IF EXISTS public.edge_events_candidate_idx;
DROP INDEX IF EXISTS public.idx_edge_events_candidate_event_id;
DROP INDEX IF EXISTS public.idx_edge_events_edge_start;

DROP INDEX IF EXISTS pmci.idx_pmci_canonical_outcomes_market;
DROP INDEX IF EXISTS pmci.idx_pmci_market_links_relationship;
DROP INDEX IF EXISTS pmci.idx_pmci_request_log_path;
DROP INDEX IF EXISTS pmci.idx_pmci_health_log_endpoint;
DROP INDEX IF EXISTS pmci.idx_provider_markets_volume_24h;
DROP INDEX IF EXISTS pmci.idx_provider_markets_template;
DROP INDEX IF EXISTS pmci.idx_ce_participants;
DROP INDEX IF EXISTS pmci.idx_pmm_provider;
