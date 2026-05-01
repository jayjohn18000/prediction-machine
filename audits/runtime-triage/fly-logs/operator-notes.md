# Fly operations evidence (2026-05-01 ~16:35Z)

## Key finding: the 2026-04-30T19:03Z restart was a deploy, not a machine cycle.

```
$ fly machine list -a pmci-mm-runtime
ID             | NAME            | VERSION | LAST UPDATED          | CREATED
6830371c057948 | wispy-moon-1571 | 20      | 2026-04-30T19:03:21Z  | 2026-04-28T15:24:28Z
```

- Machine has cycled through 20 versions since 2026-04-28. Last deploy at `2026-04-30T19:03:21Z` matches the runtime `startedAt: 2026-04-30T19:03:22.286Z` exactly.
- Single instance throughout (matches the single-instance invariant).
- Machine is healthy (1/1 checks passing).

## Log buffer limitation

`fly logs --no-tail` returned only ~100 lines covering 8 seconds (17:17:49–17:17:57Z) — Fly's retained buffer does not extend back to the 2026-04-30T15:00–19:30Z placement-collapse window we wanted. There is no external log sink (Logflare/Datadog) configured; historical logs are lost.

Recent buffer shows `depth.persist.level_counts` writes every ~1s for the 8 enabled markets — depth ingestion is persisting to DB normally. No `error`/`failed`/`rejected`/`errored` patterns in the buffer.

## Implication for Track E E.3

Track E's recommended action ("Fly logs around failures") cannot be completed retrospectively. Track F's E.3 patch (structured Kalshi error capture on `errored` rows) is the prerequisite for future operator log-archaeology. Until that ships, the placement-collapse root cause stays as Track E's most-likely hypothesis (d) without log corroboration.

Saved file: `pmci-mm-runtime-20260501.txt` (100 lines, 17:17Z window).
