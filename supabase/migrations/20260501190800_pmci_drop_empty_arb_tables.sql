-- B.3a: drop arb-era cleanup tier-1 tables.
--
-- Operator decision 2026-05-01 after Track D Q8 ("Phase G ops scripts assumed
-- cold; no cadence"): drop all four including pmci.linker_runs even though it
-- carried 140 historical rows from 2026-02-26 -> 2026-04-24. Last write was
-- 2026-04-24 15:45:47Z (the day the arb pivot closed RED). Zero writes in the
-- 7 days since.
--
-- Order matters: linker_run_metrics has a FK on linker_runs, so the dependent
-- side drops first.
--
-- This migration was applied to the live Supabase project on 2026-05-01 via
-- Supabase MCP apply_migration; this file is committed for git-history parity.

DROP TABLE IF EXISTS pmci.linker_run_metrics;
DROP TABLE IF EXISTS pmci.linker_runs;
DROP TABLE IF EXISTS pmci.unmatched_markets;
DROP TABLE IF EXISTS pmci.link_gold_labels;
