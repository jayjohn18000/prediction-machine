-- C order-reconciler — allow terminal 'errored' for failed Kalshi placements (never ACK'd).

ALTER TABLE pmci.mm_orders DROP CONSTRAINT IF EXISTS mm_orders_status_check;

ALTER TABLE pmci.mm_orders
  ADD CONSTRAINT mm_orders_status_check
  CHECK (
    status IN ('pending', 'open', 'filled', 'partial', 'cancelled', 'rejected', 'resolved', 'errored')
  );

COMMENT ON COLUMN pmci.mm_orders.status IS
  'Lifecycle; resolved = settled (W6); errored = place ACK never received after Kalshi/API failure.';
