# INGESTION_AUDITOR artifact: Polymarket “live” snapshots (partial API response)

**Goal:** Root cause why Polymarket universe ingestion appends 0 snapshots on runs when the tag listing returns events, and define the minimal fix.

---

## Root cause (one paragraph)

The Polymarket **events-by-tag** endpoint (`GET /events?tag_id=...`) returns event objects that **do include `ev.markets`**, so the code does not call `/events/slug/{slug}` (that fetch is only done when `!markets || markets.length === 0`). Those in-response market objects are **partial**: they often omit `outcomePrices` (and sometimes full `outcomes`). So `parseOutcomePrices(m)` returns null and the per-outcome loop is skipped, meaning no `ingestProviderMarket(..., priceYes)` calls and **zero snapshots appended**. In other words: the listing gives a skeleton market list; we must **always** use full event details from `/events/slug/{slug}` (which includes markets with `outcomePrices`) before ingesting, instead of trusting the listing’s `ev.markets`.

---

## Minimal change list

1. **Always fetch full event by slug for each event from the tag listing.**  
   For every event (by slug) coming from the tag listing, call `GET /events/slug/{slug}` and use the returned event’s `markets` for ingestion. Do not use `ev.markets` from the listing for price extraction.

2. **Optional but recommended:** Add a small concurrency cap (e.g. 3–5 in-flight requests) when fetching by slug to avoid rate limits.

3. **Keep existing ingestion logic:** Continue to use `provider_market_ref = \`${slug}#${outcomeName}\``; per-outcome `ingestProviderMarket(..., priceYes)` and snapshot appends unchanged.

4. **Logging:** Emit polymorph metrics: e.g. `events=N`, `markets_seen=M`, `outcomes_ingested=K`, `snapshots=K`, and optionally `events_skipped_no_prices`, `markets_skipped_missing_outcomePrices` so “live” runs are auditable.
