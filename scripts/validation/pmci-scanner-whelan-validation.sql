-- Pattern 4 — Stream B Track A (Whelan aggregate) row landing check.
-- Run after the first pmci-scanner-whelan-aggregate cron or manual POST
-- /v1/admin/jobs/pmci-scanner-whelan-aggregate.

SELECT count(*) AS n,
       detector_track,
       price_band,
       side
FROM pmci.scanner_structural_signals
WHERE observed_at > now() - interval '24 hours'
GROUP BY detector_track, price_band, side
ORDER BY detector_track, price_band, side;
