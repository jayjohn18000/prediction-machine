-- Raw execution intelligence feed: rows where Kalshi YES bid > Polymarket YES ask.
-- Query this view continuously or expose as first API endpoint.
CREATE OR REPLACE VIEW public.executable_edges_feed AS
SELECT
  candidate,
  kalshi_yes_bid,
  polymarket_yes_ask,
  kalshi_yes_bid - polymarket_yes_ask AS executable_edge,
  observed_at
FROM public.prediction_market_spreads
WHERE kalshi_yes_bid IS NOT NULL
  AND polymarket_yes_ask IS NOT NULL
  AND kalshi_yes_bid > polymarket_yes_ask;

COMMENT ON VIEW public.executable_edges_feed IS 'Execution intelligence: observations where kalshi_yes_bid > polymarket_yes_ask (arbitrage edge).';

GRANT SELECT ON public.executable_edges_feed TO anon;
GRANT SELECT ON public.executable_edges_feed TO authenticated;
