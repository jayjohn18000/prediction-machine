-- Kalshi DEMO supports fractional contracts (count_fp may be 0.02, 0.5, 1.00, 1.5...).
-- Widen size/net columns from int to numeric(20,4) so the ingestion stops silently rounding to 1.

ALTER TABLE pmci.mm_fills      ALTER COLUMN size_contracts      TYPE numeric(20,4) USING size_contracts::numeric;
ALTER TABLE pmci.mm_orders     ALTER COLUMN size_contracts      TYPE numeric(20,4) USING size_contracts::numeric;
ALTER TABLE pmci.mm_orders     ALTER COLUMN fill_size_contracts TYPE numeric(20,4) USING fill_size_contracts::numeric;
ALTER TABLE pmci.mm_positions  ALTER COLUMN net_contracts       TYPE numeric(20,4) USING net_contracts::numeric;

COMMENT ON COLUMN pmci.mm_fills.size_contracts IS
  'Fractional contracts; Kalshi DEMO sometimes fills 0.02 etc., recorded as count_fp from /portfolio/fills.';
