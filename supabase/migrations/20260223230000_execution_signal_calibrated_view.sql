-- Percentile-calibrated execution signals for /execution-decision.
-- Adds score_percentile and execute_default (top 10%) from execution_signal_quality.
-- No schema changes to base tables.

CREATE OR REPLACE VIEW public.execution_signal_calibrated AS
SELECT
  candidate,
  event_id,
  execution_score,
  avg_edge,
  avg_duration_seconds,
  events_per_hour,
  last_seen,
  percent_rank() OVER (ORDER BY execution_score)::double precision AS score_percentile,
  (percent_rank() OVER (ORDER BY execution_score) >= 0.90) AS execute_default
FROM public.execution_signal_quality;

COMMENT ON VIEW public.execution_signal_calibrated IS 'Execution signals with score_percentile (0–1) and execute_default (true if top 10%).';

GRANT SELECT ON public.execution_signal_calibrated TO anon;
GRANT SELECT ON public.execution_signal_calibrated TO authenticated;
