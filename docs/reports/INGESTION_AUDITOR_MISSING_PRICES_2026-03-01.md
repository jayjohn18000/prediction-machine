# INGESTION_AUDITOR: PMCI politics universe — missing_prices derivation

**Date:** 2026-03-01  
**Scope:** Polymarket markets skipped with reason `missing_prices` when `outcomePrices` are missing but `outcomes` exist (364 markets in user run).  
**Goal:** Derive `priceYes` when `outcomePrices` missing (prefer outcomePrices; else bestBid/bestAsk mid; else lastTradePrice); keep auditable (record which method).

---

## 1) Sample missing_prices markets (evidence)

Probe script `scripts/pmci-probe-missing-prices.mjs` was run with `PMCI_POLITICS_POLY_TAG_ID=2`. It fetches events by slug from `gamma-api.polymarket.com/events/slug/{slug}` and collects markets that have `outcomes` but missing or empty `outcomePrices`. **Three samples** were collected from event `democratic-presidential-nominee-2028`:

| Field           | Sample 1 (id=559697) | Sample 2 (id=559700) | Sample 3 (id=559709) |
|----------------|----------------------|----------------------|----------------------|
| outcomes       | `["Yes", "No"]`      | `["Yes", "No"]`      | `["Yes", "No"]`      |
| outcomePrices  | (absent)             | (absent)             | (absent)             |
| lastTradePrice | 0                    | 0                    | 0                    |
| bestBid        | 0                    | 0                    | 0                    |
| bestAsk        | 1                    | 1                    | 1                    |
| enableOrderBook| true                 | true                 | true                 |

**Raw shape:** Each market object has top-level keys `lastTradePrice`, `bestBid`, `bestAsk` (and many others; see probe output). No `outcomePrices` (or `outcome_prices` / `prices`) array present on these markets.

---

## 2) Field level: market-level vs per-outcome

- **lastTradePrice, bestBid, bestAsk** on the Gamma API market object are **market-level**: one numeric value per market.
- Polymarket CLOB/orderbook is per token (Yes/No); for **binary** markets the Gamma API exposes a single best bid/ask/last trade, which corresponds to the **Yes** token (standard convention).
- There are **no per-outcome arrays** for these fields on the Gamma market object; per-token data would require the CLOB API (token IDs) separately.

**Conclusion:** For derivation we have exactly one number per market (mid or lastTradePrice). Mapping must be **market-level → one derived price**, applied to the Yes outcome (and optionally 1−price for No in binary markets).

---

## 3) Decision: mapping rule

| Aspect | Decision |
|--------|----------|
| **Level** | Market-level (one derived price per market). |
| **Preference** | 1) Use `outcomePrices` when present and length matches outcomes. 2) Else derive: **mid(bestBid, bestAsk)** when both are numeric; else **lastTradePrice**. |
| **Mapping** | **Binary [Yes, No]:** Use derived price for the **Yes** outcome. Option A (current): ingest **Yes only** (one snapshot per market). Option B: ingest both Yes and No with `[derived, 1 - derived]` so probabilities sum to 1. |
| **Multi-outcome** | When outcomePrices are missing and we only have one market-level number, ingest **Yes outcome only** (or the first outcome if no literal "Yes"); do not invent per-outcome splits. |
| **Auditability** | Store **price_source** in `raw._pmci`: `"outcomePrices"` \| `"mid"` \| `"lastTradePrice"`. |

---

## 4) Risks

- **Wide spread (bestBid=0, bestAsk=1):** Mid = 0.5 may reflect “no liquidity” rather than true probability; still better than skipping.
- **lastTradePrice=0:** Can be stale or indicate no recent trade; prefer mid when both bid/ask present.
- **Yes-only vs Yes+No:** Ingesting only Yes leaves No unrepresented in snapshots for that market; ingesting both with [derived, 1−derived] keeps binary coherence but doubles snapshot rows per market when using derived price.
- **Multi-outcome:** Using one derived value only for the Yes outcome underrepresents other outcomes; acceptable as best-effort when outcomePrices are missing.

---

## 5) Minimal fix recommendation (for REPORTER)

The codebase **already implements** the derivation and Path 2 in `scripts/pmci-ingest-politics-universe.mjs`:

- **getDerivedPrice(m):** Prefers mid(bestBid, bestAsk), then lastTradePrice; returns `{ price, source: 'mid' | 'lastTradePrice' }`.
- **Path 1:** outcomePrices available → use them; `price_source: 'outcomePrices'` in `raw._pmci`.
- **Path 2:** outcomePrices missing but derived available → ingest **Yes outcome only**, with `price_source: derived.source` in `raw._pmci`.
- **Reporting:** `snapshots_from_outcomePrices`, `snapshots_from_mid`, `snapshots_from_lastTradePrice`, `still_missing_prices` are logged.

**REPORTER should ensure:**

1. **Preference order** is exactly: outcomePrices (when present and length matches) → mid(bestBid, bestAsk) → lastTradePrice. *(Already in place.)*
2. **Auditability:** Every snapshot has `raw._pmci.price_source` = `"outcomePrices"` \| `"mid"` \| `"lastTradePrice"`. *(Already in place.)*
3. **Optional:** Populate `bestBidYes` / `bestAskYes` when we have market-level bestBid/bestAsk (for derived path), so downstream can see spread. *(Currently set to null in Path 2.)*
4. **Optional (binary coherence):** For Path 2 binary markets, consider ingesting both Yes and No with prices `[derived.price, 1 - derived.price]` and same `price_source`, so coverage is symmetric; document that this is derived and may be mid/0.5 when spread is wide.
5. **Probe:** Keep `scripts/pmci-probe-missing-prices.mjs` for future audits; run with `PMCI_POLITICS_POLY_TAG_ID` set to sample missing_prices markets from politics.

---

## 6) Probe usage

```bash
# With politics tag (from .env or inline)
PMCI_POLITICS_POLY_TAG_ID=2 node scripts/pmci-probe-missing-prices.mjs

# Single event by slug
node scripts/pmci-probe-missing-prices.mjs democratic-presidential-nominee-2028
```

Output: up to 3 market objects with outcomes but missing/empty outcomePrices, including `lastTradePrice`, `bestBid`, `bestAsk`, and `allKeys`.
