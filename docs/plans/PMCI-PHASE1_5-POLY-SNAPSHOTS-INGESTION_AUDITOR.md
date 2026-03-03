## INGESTION_AUDITOR artifact: Phase 1.5 — Polymarket snapshots fix (politics universe)

**Goal:** Explain why polymarket universe ingestion reports `snapshots=0` and define the smallest ingestion-only fix to append `pmci.provider_market_snapshots.price_yes` for politics outcomes.

---

### 1) Root cause (why snapshots=0 for Polymarket universe)

- **Endpoint used:** `scripts/pmci-ingest-politics-universe.mjs` calls:
  - `GET https://gamma-api.polymarket.com/events?tag_id=...&active=true&closed=false&limit=...&offset=...`
  - For each event, it ensures full details via `GET /events/slug/{slug}` to get `markets` with `outcomes` + `outcomePrices`.
- **Current universe ingestion logic (Polymarket):**
  - For each `market m`:
    - Builds a single provider market: `provider_market_ref = slug#marketId`.
    - Calls `findYesPrice(m)`, which:
      - Looks for an outcome literally equal to `"Yes"` (case-insensitive).
      - If not found but there are exactly 2 outcomes, returns `prices[0]`.
      - Otherwise returns `null`.
    - Calls `ingestProviderMarket()` with `priceYes = findYesPrice(m)`.
    - `ingestProviderMarket()` only appends a snapshot row when `priceYes` is a number.
- **Politics nomination markets structure (from Gamma docs + behavior):**
  - Markets for nomination / election often have **candidate names** as outcomes, e.g.:
    - `outcomes = ["Kamala Harris", "Gavin Newsom", ...]`
    - `outcomePrices = ["0.23", "0.18", ...]`
  - There is **no literal 'Yes' outcome**, and outcome count is often > 2.
- **Consequence:** For these multi-candidate markets:
  - `findYesPrice(m)` returns `null` (no 'Yes', more than 2 outcomes).
  - `ingestProviderMarket()` therefore upserts provider_markets but **skips snapshots**, so `snapshots=0` for polymarket in the universe run.

---

### 2) Where price_yes should come from

- For **politics markets with multiple candidates per event**, each candidate is effectively a “yes” outcome for a separate contract.
- The correct `price_yes` for a candidate-level provider market is the **per-outcome probability** from `market.outcomePrices[i]` for outcome `outcomes[i]`.
- This matches the existing paired flow:
  - The observer’s paired ingestion (`observer.mjs` + `buildPolymarketPriceMap`) treats each candidate outcome as its own leg, using `outcomePrices[0]` for the candidate identified by `polymarketOutcomeName`.

**Decision for universe ingestion (politics only):**
- Treat each outcome of a Polymarket politics market as its own provider market row, with:
  - `provider_market_ref = slug#outcomeName` (consistent with event_pairs and paired ingestion).
  - `price_yes = clamp01(outcomePrices[i])` for that outcome.
  - Optional: reuse market-level liquidity/volume fields for all outcomes (heuristics-only).

---

### 3) Minimal fix plan (ingestion-only, no schema changes)

**Files to touch:**
- `scripts/pmci-ingest-politics-universe.mjs` (Polymarket path only).

**Diff outline (Polymarket path):**
- **Stop** treating each Polymarket `market` as a single provider market with `provider_market_ref = slug#marketId` and `price_yes = findYesPrice(m)`.
- **Instead, for each event:**
  1. Ensure we have full event data: if `ev.markets` is empty, already fetch `GET /events/slug/{slug}` (keep this behavior).
  2. For each `market m` in `markets`:
     - Read `outcomes = m.outcomes` and `prices = parseOutcomePrices(m)`; ensure both arrays exist and lengths match.
     - For each `i` in outcomes:
       - `outcomeName = String(outcomes[i])`.
       - `priceYes = clamp01(prices[i])`.
       - Build provider market input:
         - `provider_market_ref = slug#outcomeName` (aligns with existing `event_pairs` convention).
         - `event_ref = slug`.
         - `title = m.question || m.title || \`\${slug}#\${outcomeName}\``.
         - `category = 'politics'`.
         - `status = (m.active ? 'open' : m.closed ? 'closed' : null)`.
         - `metadata` includes: `source = 'pmci-ingest-politics-universe'`, `mode = 'universe'`, `provider = 'polymarket'`, `tag_id`, `market_id`, `outcome_index`, `outcome_name`.
         - `priceYes = priceYes`.
         - `bestBidYes` / `bestAskYes`: **optional**, can be left `null` for now (market-level bestBid/bestAsk are not outcome-specific).
         - `liquidity` / `volume24h`: re-use market-level fields (optional but acceptable for heuristics).
       - Call `ingestProviderMarket()` with this input and `observedAt` from the universe run.
  3. Increment `marketsUpserted` and `snapshotsAppended` via `addIngestionCounts()` as before.

**Side-effects and alignment:**
- Existing paired ingestion already uses `provider_market_ref = polymarketSlug#polymarketOutcomeName` for candidate legs.
  - Universe ingestion will therefore **upsert** the same rows (when both are present) rather than create duplicates.
  - New candidate outcomes not in `event_pairs.json` will become **new provider_markets** (unlinked universe), which is exactly what Phase 1 wanted.
- No changes required to `lib/pmci-ingestion.mjs` beyond what’s already implemented for single-market ingest; snapshots still only append when `priceYes` is a number.

---

### 4) Sanity checklist (Polymarket universe)

- [ ] After the change, `pmci-ingest-politics-universe` logs `polymarket(... snapshots>0)`.
- [ ] `pmci.provider_markets` for provider `polymarket` contains refs like `democratic-presidential-nominee-2028#Kamala Harris`.
- [ ] `pmci.provider_market_snapshots` joined to polymarket provider_markets has `price_yes` > 0 for at least some rows.
- [ ] `/v1/markets/unlinked?provider=polymarket&category=politics&limit=10` returns markets whose `provider_market_ref` matches the `slug#candidate` pattern.
- [ ] No schema changes; observer and paired ingestion behavior remain intact.

