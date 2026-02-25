-- Add bid/ask and liquidity columns for execution-edge detection.
-- Executable edge: kalshi_yes_bid > polymarket_yes_ask.
ALTER TABLE public.prediction_market_spreads
  ADD COLUMN IF NOT EXISTS kalshi_yes_bid double precision,
  ADD COLUMN IF NOT EXISTS kalshi_yes_ask double precision,
  ADD COLUMN IF NOT EXISTS kalshi_open_interest double precision,
  ADD COLUMN IF NOT EXISTS kalshi_volume_24h double precision,
  ADD COLUMN IF NOT EXISTS polymarket_yes_bid double precision,
  ADD COLUMN IF NOT EXISTS polymarket_yes_ask double precision;

COMMENT ON COLUMN public.prediction_market_spreads.kalshi_yes_bid IS 'Kalshi YES bid (buy) price.';
COMMENT ON COLUMN public.prediction_market_spreads.kalshi_yes_ask IS 'Kalshi YES ask (sell) price.';
COMMENT ON COLUMN public.prediction_market_spreads.polymarket_yes_bid IS 'Polymarket YES best bid.';
COMMENT ON COLUMN public.prediction_market_spreads.polymarket_yes_ask IS 'Polymarket YES best ask.';
