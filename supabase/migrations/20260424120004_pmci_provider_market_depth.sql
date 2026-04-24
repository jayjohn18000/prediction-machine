-- pmci.provider_market_depth — Kalshi L2 order-book snapshots for MM MVP (W1).
--
-- Per docs/plans/phase-mm-mvp-plan.md §"Supabase schema additions".
-- Columns renamed from the plan's original {bids, asks} to {yes_levels, no_levels}
-- to match Kalshi's actual WS message shape: both sides are BID ladders (YES-bids
-- and NO-bids), not a bid/ask pair. YES-ask is derived at read time as
-- 100 - best_no_bid. See plan doc §"W1 spec-check corrections" for the design call.
--
-- Idempotent inserts: UNIQUE (provider_market_id, observed_at) allows the
-- downsampler to safely re-emit rows on restart without duplicating.
--
-- Population: lib/ingestion/depth.mjs (MM runtime). Not populated by observer.mjs.

CREATE TABLE IF NOT EXISTS pmci.provider_market_depth (
  id                  bigserial PRIMARY KEY,
  provider_market_id  bigint NOT NULL REFERENCES pmci.provider_markets(id),
  observed_at         timestamptz NOT NULL,
  yes_levels          jsonb NOT NULL,   -- [[price_cents, qty], ...] top 10 by price desc
  no_levels           jsonb NOT NULL,   -- [[price_cents, qty], ...] top 10 by price desc
  mid_cents           numeric,           -- (best_yes_bid + (100 - best_no_bid)) / 2; NULL if either side empty or crossed
  spread_cents        int,               -- (100 - best_no_bid) - best_yes_bid; NULL if either side empty or crossed
  UNIQUE (provider_market_id, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_provider_market_depth_market_time
  ON pmci.provider_market_depth (provider_market_id, observed_at DESC);

COMMENT ON TABLE pmci.provider_market_depth IS
  'Kalshi L2 order-book snapshots, 1Hz downsampled. Populated by lib/ingestion/depth.mjs (MM MVP W1). Kalshi sends YES-bid and NO-bid ladders; YES-ask is derived as 100 - best_no_bid.';

COMMENT ON COLUMN pmci.provider_market_depth.yes_levels IS
  'YES-bid ladder from Kalshi orderbook_snapshot/delta. Array of [price_cents, qty] pairs, top 10 by price descending (best bid first).';

COMMENT ON COLUMN pmci.provider_market_depth.no_levels IS
  'NO-bid ladder from Kalshi orderbook_snapshot/delta. Array of [price_cents, qty] pairs, top 10 by price descending (best bid first).';

COMMENT ON COLUMN pmci.provider_market_depth.mid_cents IS
  'YES-market mid: (best_yes_bid + (100 - best_no_bid)) / 2. NULL if either side empty or book is crossed.';

COMMENT ON COLUMN pmci.provider_market_depth.spread_cents IS
  'YES-market spread: (100 - best_no_bid) - best_yes_bid. NULL if either side empty or book is crossed.';
