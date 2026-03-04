# Discover Kalshi politics series for PMCI

Use this to expand `PMCI_POLITICS_KALSHI_SERIES_TICKERS` so politics universe ingestion pulls in more Kalshi markets (improving balance with Polymarket and enabling proxy proposals).

## Command

```bash
npm run pmci:discover:kalshi:politics
```

Optional env: `PMCI_DISCOVER_DELAY_MS=200` (delay between series checks); `PMCI_DISCOVER_MAX_SERIES=80` (cap so the run finishes in ~1–2 min instead of 30+ min when many series match).

## What it does

- Calls Kalshi `GET /series` (same base URLs as `scripts/pmci-ingest-politics-universe.mjs`), paginating with `cursor`.
- Filters series by politics-like keywords in `title`, `category`, and `tags`: election, president, congress, senate, house, governor, nominee, primary, vote, fed, supreme court, impeachment, 2028, 2026, etc.
- For each likely politics series, checks `GET /events?series_ticker=...&limit=1` to confirm it has events.
- Prints a table of ticker, title, category, then at the **end** a line you can copy into `.env`:

  `PMCI_POLITICS_KALSHI_SERIES_TICKERS="TICKER1,TICKER2,..."`

  **Where to put it:** In your project root, open `.env` and add (or replace) that full line. The value is the quoted part after the `=`. If discover hit a rate limit (429) before finishing, run it again with a longer delay, e.g. `PMCI_DISCOVER_DELAY_MS=500 npm run pmci:discover:kalshi:politics`, and scroll to the bottom of the output to find the copy-paste line.

## After updating env

1. Set or append the printed tickers in `.env` as `PMCI_POLITICS_KALSHI_SERIES_TICKERS`.
2. Re-run universe ingestion: `npm run pmci:ingest:politics:universe`.
3. Re-run proposer: `npm run pmci:propose:politics`. Target: `kalshi_unlinked_count >= 100` and `proposals_written_proxy > 0` (with `min_confidence >= 0.88`).
