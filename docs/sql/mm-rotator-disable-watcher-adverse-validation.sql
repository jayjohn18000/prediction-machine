-- mm-rotator-disable-watcher: verify adverse-selection auto-blocklist (high_adverse_selection)
--
-- After deploy: cron runs every 5 minutes. Within ~1h of sustained toxic fills,
-- expect rows when any enabled market had ≥10 fills in the rolling 1h window with
-- AVG(adverse_cents_5m) < -1.5.
--
-- Synthetic: not applicable in production; use this query on live DB only.

SELECT ticker, reason, blocked_at, notes
FROM pmci.mm_ticker_blocklist
WHERE reason = 'high_adverse_selection'
  AND blocked_at > now() - interval '1 hour'
ORDER BY blocked_at DESC;
