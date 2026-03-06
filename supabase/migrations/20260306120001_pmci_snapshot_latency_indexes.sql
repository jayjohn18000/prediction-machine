-- Migration: PMCI snapshot latency indexes
-- Fixes api_p95_latency SLO regression (881ms → target <200ms)
--
-- Root cause: max(observed_at) on 405K snapshot rows takes 454ms because the
-- existing composite index (provider_market_id, observed_at DESC) can't answer
-- a global max without scanning all 2,814 provider_market_id key groups.
-- The freshness endpoint and assertFreshness preHandler both run this query,
-- compounding latency on every /v1/signals/* hit and /v1/health/slo poll.

-- Fix 1: Dedicated descending index for global max(observed_at) lookups.
-- Makes max(observed_at) an O(1) index read (~5ms vs 454ms).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pmci_snapshots_observed_at_desc
  ON pmci.provider_market_snapshots (observed_at DESC);

-- Fix 2: Index on provider_markets.provider_id for the per-provider
-- latest-snapshot join in /v1/health/freshness.
-- Allows index-only scan of markets per provider instead of full seq scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pmci_provider_markets_provider_id
  ON pmci.provider_markets (provider_id);
