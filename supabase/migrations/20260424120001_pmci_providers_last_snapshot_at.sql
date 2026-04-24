-- Freshness cache: avoid scanning 3.5M rows of provider_market_snapshots
-- every time /v1/health/freshness (and callers of computeLiveFreshnessSnapshot)
-- compute MAX(observed_at). Adds a denormalized last_snapshot_at on
-- pmci.providers that's maintained by the observer's batch-commit path
-- (see lib/ingestion/observer-cycle.mjs + lib/pmci-ingestion.mjs).
--
-- Impact (audit 2026-04-24): the existing runtime-status query was the #1
-- Disk IO consumer on the project — 40K calls, ~97h of total exec time,
-- ~97% of all shared-block reads. With this column, the query becomes a
-- two-row read on the small providers table.
--
-- Maintenance strategy — application code, NOT a trigger:
--   The obvious approach is an AFTER INSERT statement-level trigger on
--   provider_market_snapshots. We tried that and backed out: creating the
--   trigger requires AccessExclusiveLock on a table receiving ~3-5 INSERTs/s,
--   which the observer never stops doing. The migration would queue behind
--   every in-flight INSERT and every in-flight reader for as long as it
--   takes for the INSERT pipeline to drain (which, in practice, is "never"
--   during business hours). Trigger overhead per batch is also non-trivial.
--
--   Instead, the observer calls updateProviderLastSnapshotAt(providerId, ts)
--   at the end of each cycle after its snapshot batch commits. Writes are
--   idempotent (GREATEST(existing, new_ts)) so out-of-order / late batches
--   cannot regress the timestamp.

ALTER TABLE pmci.providers
  ADD COLUMN IF NOT EXISTS last_snapshot_at timestamptz;

-- Backfill note (executed out-of-band via execute_sql, not repeatable here):
--
--   UPDATE pmci.providers p
--   SET last_snapshot_at = r.max_at
--   FROM (
--     SELECT pm.provider_id, max(s.observed_at) AS max_at
--     FROM pmci.provider_market_snapshots s
--     JOIN pmci.provider_markets pm ON pm.id = s.provider_market_id
--     WHERE s.observed_at > now() - interval '10 minutes'
--     GROUP BY pm.provider_id
--   ) r WHERE p.id = r.provider_id;
--
-- A full-history backfill times out on the 3.5M-row snapshot table via MCP;
-- the 10-minute window hits idx_pmci_snapshots_observed_at_desc and returns
-- in milliseconds. The observer refreshes this value within a single cycle
-- of boot, so a bounded-window backfill is safe.

COMMENT ON COLUMN pmci.providers.last_snapshot_at IS
  'Most recent observed_at across all provider_market_snapshots for this provider. Maintained by observer-cycle.mjs after each snapshot batch commit (see updateProviderLastSnapshotAt). Read by computeLiveFreshnessSnapshot / /v1/health/freshness to avoid a full-table MAX scan.';
