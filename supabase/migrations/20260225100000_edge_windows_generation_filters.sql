-- Window Generator Surgeon: filter degenerate windows at source.
-- MIN_DURATION_SECONDS = 60, MIN_TICKS = 2, MIN_EDGE = 0.001 (optional noise filter).
-- Exposes edge_windows_generation (all raw windows + rejection_reason) for instrumentation.
-- edge_windows becomes accepted-only (rejection_reason IS NULL).

-- Single source: raw windows with rejection reason
CREATE OR REPLACE VIEW public.edge_windows_generation AS
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
  ),
  with_reason AS (
    SELECT
      candidate,
      event_id,
      (candidate || '|' || event_id || '|' || edge_start::text) AS window_id,
      edge_start,
      edge_end,
      duration_seconds,
      observations,
      max_edge,
      avg_edge,
      CASE
        WHEN duration_seconds IS NULL OR duration_seconds < 60 THEN 'duration_too_short'
        WHEN observations IS NULL OR observations < 2 THEN 'too_few_ticks'
        WHEN avg_edge IS NOT NULL AND avg_edge < 0.001 THEN 'edge_too_small'
        ELSE NULL
      END AS rejection_reason
    FROM agg
  )
SELECT
  candidate,
  event_id,
  window_id,
  edge_start,
  edge_end,
  duration_seconds,
  observations,
  max_edge,
  avg_edge,
  rejection_reason
FROM with_reason;

COMMENT ON VIEW public.edge_windows_generation IS 'All contiguous executable windows with rejection_reason: duration_too_short (<60s), too_few_ticks (<2), edge_too_small (<0.001), or NULL if accepted.';

-- Accepted windows only (backward-compatible signature)
CREATE OR REPLACE VIEW public.edge_windows AS
SELECT
  candidate,
  event_id,
  window_id,
  edge_start,
  edge_end,
  duration_seconds,
  observations,
  max_edge,
  avg_edge
FROM public.edge_windows_generation
WHERE rejection_reason IS NULL;

COMMENT ON VIEW public.edge_windows IS 'Contiguous executable windows: gap <= 90s; duration >= 60s; observations >= 2; avg_edge >= 0.001. Rejected windows see edge_windows_generation.';

GRANT SELECT ON public.edge_windows_generation TO anon;
GRANT SELECT ON public.edge_windows_generation TO authenticated;
GRANT SELECT ON public.edge_windows TO anon;
GRANT SELECT ON public.edge_windows TO authenticated;
