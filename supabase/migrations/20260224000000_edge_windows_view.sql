-- Contiguous executable windows per (candidate, event_id).
-- Source: prediction_market_spreads. A window = consecutive executable rows
-- with gap between observations <= 90 seconds; gap > 90s or non-executable starts a new window.
-- Do not modify prediction_market_spreads or existing tables.

CREATE OR REPLACE VIEW public.edge_windows AS
WITH
  executable AS (
    SELECT
      candidate,
      event_id,
      observed_at,
      (kalshi_yes_bid - polymarket_yes_ask) AS edge
    FROM public.prediction_market_spreads
    WHERE kalshi_yes_bid IS NOT NULL
      AND polymarket_yes_ask IS NOT NULL
      AND kalshi_yes_bid > polymarket_yes_ask
  ),
  with_gap AS (
    SELECT
      candidate,
      event_id,
      observed_at,
      edge,
      observed_at - LAG(observed_at) OVER (
        PARTITION BY candidate, event_id
        ORDER BY observed_at
      ) AS gap
    FROM executable
  ),
  with_grp AS (
    SELECT
      candidate,
      event_id,
      observed_at,
      edge,
      SUM(CASE
        WHEN gap IS NULL OR gap > interval '90 seconds' THEN 1
        ELSE 0
      END) OVER (
        PARTITION BY candidate, event_id
        ORDER BY observed_at
      ) AS grp
    FROM with_gap
  ),
  agg AS (
    SELECT
      candidate,
      event_id,
      grp,
      MIN(observed_at) AS edge_start,
      MAX(observed_at) AS edge_end,
      EXTRACT(EPOCH FROM (MAX(observed_at) - MIN(observed_at)))::integer AS duration_seconds,
      COUNT(*)::integer AS observations,
      MAX(edge)::double precision AS max_edge,
      AVG(edge)::double precision AS avg_edge
    FROM with_grp
    GROUP BY candidate, event_id, grp
  )
SELECT
  candidate,
  event_id,
  (candidate || '|' || event_id || '|' || edge_start::text) AS window_id,
  edge_start,
  edge_end,
  duration_seconds,
  observations,
  max_edge,
  avg_edge
FROM agg;

COMMENT ON VIEW public.edge_windows IS 'Contiguous executable windows: gap <= 90s between observations; new window on gap > 90s or when executable is false.';

GRANT SELECT ON public.edge_windows TO anon;
GRANT SELECT ON public.edge_windows TO authenticated;
