# Oddpool API sampling summary (2026-04-14)

Sampled via `X-API-Key` header against `https://api.oddpool.com/search/*` endpoints. Free tier: 1K req/month, 1 req/sec.

## Event counts by query

| Query | Total Events | Kalshi | Polymarket | Total Markets (sum of market_count) |
|-------|-------------|--------|------------|--------------------------------------|
| president | 46 | 17 | 29 | 124 |
| bitcoin | 100 | 17 | 83 | 851 |
| nba | 26 | 1 | 25 | 119 |
| fed rate | 100 | 93 | 7 | 896 |
| governor | 100 | 97 | 3 | 555 |
| senate | 100 | 92 | 8 | 520 |
| mlb | 30 | 0 | 30 | 363 |
| nhl | 25 | 10 | 15 | 284 |
| ethereum | 100 | 9 | 91 | 504 |
| soccer | 2 | 1 | 1 | 32 |
| mma | 0 | 0 | 0 | 0 |
| weather | 1 | 0 | 1 | 7 |
| recent events | 100 | 96 | 4 | 432 |

## Key observations

1. **Kalshi dominance in economics/politics:** "fed rate" (93 Kalshi / 7 Poly), "governor" (97 / 3), "senate" (92 / 8). Oddpool discovers the full breadth of Kalshi series that PMCI only partially ingests.
2. **Polymarket dominance in crypto/sports:** "bitcoin" (17 Kalshi / 83 Poly), "ethereum" (9 / 91), "mlb" (0 / 30), "nba" (1 / 25).
3. **Cross-venue overlap signal:** Both venues appear for bitcoin, nba, nhl, president, senate — these are the categories where PMCI can find cross-venue pairs.
4. **MMA = 0 events, weather = 1, soccer = 2:** Low coverage here even on Oddpool.

## Top events by volume (across all queries)

| Exchange | Markets | Volume ($K) | Event ID | Title |
|----------|---------|-------------|----------|-------|
| kalshi | 28 | 21,399K | KXBTCY-27JAN0100 | Bitcoin price at the end of 2026 |
| kalshi | 25 | 20,771K | KXGOVCA-26 | California Governor winner? |
| kalshi | 5 | 12,339K | KXFEDDECISION-26APR | Fed decision in Apr 2026? |
| kalshi | 5 | 12,235K | KXSENATETXR-26 | Texas Republican Senate nominee? |
| kalshi | 18 | 11,323K | KXETHY-27JAN0100 | Ethereum price at the end of 2026 |
| kalshi | 5 | 7,255K | KXTRUMPOUT27-27 | Donald Trump out as President? |
| kalshi | 6 | 4,363K | KXBTCMAX100-26 | When will Bitcoin cross $100k again? |
| polymarket | 1 | 4,174K | trump-out-as-president-before-2027 | Trump out as President before 2027? |
| kalshi | 1 | 3,761K | KXBTC2026200-27JAN01 | Will Bitcoin be above $200k by 2027? |
| kalshi | 6 | 3,742K | KXTXSENCOMBO-26NOV | 2026 Texas Senate matchup? |

## Event grouping structure (Oddpool model)

Oddpool uses the **native exchange event ID** as its `event_id`:
- Kalshi: `KXBTCY-27JAN0100`, `KXGOVCA-26`, `KXFEDDECISION-26APR`, etc.
- Polymarket: `trump-out-as-president-before-2027`, `nhl-tb-ott-2026-04-07`, etc.

Each event contains multiple `market_id` entries. A Kalshi event like `KXBTCY-27JAN0100` contains 28 individual strike-level markets (e.g. `KXBTCY-27JAN0100-B72500`, `KXBTCY-27JAN0100-B47500`).

Market fields: `market_id`, `exchange`, `question`, `category`, `status`, `volume`, `liquidity`, `last_yes_price`, `last_no_price`, `has_orderbook`, `event_id`, `event_title`, `slug`, `discovered_at`.

## Categories PMCI does NOT currently ingest

- **Crypto** (bitcoin, ethereum): E2 planned; Oddpool shows 100+ events per query.
- **Economics/Macro** (fed rate, rate cuts): 100 events on Oddpool, 93 from Kalshi alone.
- **Weather**: minimal (1 event).
- **Entertainment/Culture**: not queried here but known from Oddpool marketing.

## PMCI ingestion gap: Kalshi series not in PMCI

Oddpool's top events include Kalshi series tickers not present in PMCI's `PMCI_POLITICS_KALSHI_SERIES_TICKERS`:
- `KXBTCY`, `KXETHY`, `KXBTCMAX100`, `KXBTCMAXY` (crypto)
- `KXFEDDECISION`, `KXRATECUTCOUNT` (economics)
- `KXWTI`, `KXWTIW` (commodities/financials)
- `KXSURVIVOR` (entertainment)

These represent high-volume verticals that competitors surface but PMCI skips.
