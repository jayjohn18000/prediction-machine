# INGESTION_AUDITOR artifact: Polymarket parsing + attribution

**Goal:** Root cause why 691/691 markets are skipped (outcomes_ingested=0) and define fixes so universe ingestion reliably appends snapshots with clear attribution.

---

## 1) Observer attribution (confirm)

- **Same DB:** The observer (`npm run start`) and the universe script both write to `pmci.provider_market_snapshots` when `DATABASE_URL` points at the same project. If the observer is running while you run the universe script, snapshot counts and `latest_observed_at` can advance from **either** process.
- **Conclusion:** Observer could have been writing during the test. To attribute growth to the universe script only, **stop the observer** before running `npm run pmci:ingest:politics:universe`, then run `npm run pmci:check:poly` before and after.

---

## 2) Parsing assumption that fails

- **Observed:** 691 markets skipped, 50 events with no prices; all classified as missing outcomePrices / invalid outcomes.
- **Assumption:** Markets from `GET /events/slug/{slug}` have `outcomes` and `outcomePrices` (or `outcome_prices` / `prices`) as arrays—or stringified JSON that we `JSON.parse`. If the Gamma API returns a different shape (e.g. different key names, nested object, or single string that is not JSON), `parseOutcomes(m)` or `parseOutcomePrices(m)` return `null` and we skip the market.
- **Debug sample (first 3 skipped):** The script now logs for the first 3 skipped markets:
  - `reason` = one of: `missing_outcomes`, `missing_prices`, `parse_error`, `length_mismatch`
  - `typeof m.outcomes`, `typeof m.outcomePrices`
  - `Object.keys(m)`
  - First 200 chars of `m.outcomes` and `m.outcomePrices`
- **Use:** Run the universe script once and inspect those lines to see the exact key names and types; then extend parsing (e.g. more keys or nested path) if needed.

---

## 3) Root cause (concise)

- Every market is failing the “has outcomes and prices with matching length” check. That implies either (a) the API does not return `outcomes` / `outcomePrices` (or our alternate keys) on the full event-by-slug response, or (b) they are in an unexpected format (e.g. different key, or string that is not valid JSON). The first-3 debug sample identifies which.

---

## 4) Fix checklist (implemented)

- [x] **Robust parsing:** `outcomes` / `outcomePrices` as strings → `JSON.parse`; prices as strings → `Number()`/parseFloat and clamp [0,1]. Alternate keys: `outcomeNames`, `outcome_prices`, `prices`.
- [x] **Skip reasons:** Classify each skip as `missing_outcomes`, `missing_prices`, `parse_error`, or `length_mismatch`; increment `skipped_by_reason` and log first 3 with full debug.
- [x] **Snapshot attribution:** Each snapshot written by the universe script has `raw._pmci = { source: 'pmci-ingest-politics-universe', mode: 'universe', slug, tag_id, ... }`.
- [x] **Logging:** Final log includes `polymarket(..., markets_skipped_missing_outcomePrices=N)` and `skipped_by_reason: { missing_outcomes, missing_prices, parse_error, length_mismatch }`.
- [x] **Validation:** Run with observer OFF (documented in README). Script exits 1 if `eventsVisited > 0` and `snapshotsAppended === 0`. `pmci:check:poly` prints `universe_attributed=<n>` and, when `PMCI_REQUIRE_UNIVERSE_SNAPSHOTS=1`, fails if that count is 0.
