-- Ranked execution signals for the /signals/top API.
-- Aggregates edge_events by (candidate, event_id) with execution_score for ordering.
-- Do not modify edge_events or executable_edges_feed.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.execution_signal_quality AS
WITH agg AS (
  SELECT
    candidate,
    event_id,
    AVG(avg_edge)::double precision AS avg_edge,
    AVG(duration_seconds)::double precision AS avg_duration_seconds,
    COUNT(*)::integer AS event_count,
    MIN(edge_start) AS first_seen,
    MAX(edge_end) AS last_seen
  FROM public.edge_events
  GROUP BY candidate, event_id
),
with_rate AS (
  SELECT
    candidate,
    event_id,
    avg_edge,
    avg_duration_seconds,
    last_seen,
    CASE
      WHEN EXTRACT(EPOCH FROM (last_seen - first_seen)) <= 0 THEN 0
      ELSE event_count::double precision / (EXTRACT(EPOCH FROM (last_seen - first_seen)) / 3600.0)
    END AS events_per_hour
  FROM agg
)
SELECT
  candidate,
  event_id,
  (avg_edge * (1 + LN(1 + LEAST(events_per_hour, 100))))::double precision AS execution_score,
  avg_edge,
  avg_duration_seconds,
  events_per_hour,
  last_seen
FROM with_rate;

COMMENT ON MATERIALIZED VIEW public.execution_signal_quality IS 'Ranked execution signals: one row per (candidate, event_id) with execution_score for API ordering.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_signal_quality_candidate_event_id
  ON public.execution_signal_quality (candidate, event_id);
CREATE INDEX IF NOT EXISTS idx_execution_signal_quality_execution_score
  ON public.execution_signal_quality (execution_score DESC);

GRANT SELECT ON public.execution_signal_quality TO anon;
GRANT SELECT ON public.execution_signal_quality TO authenticated;
