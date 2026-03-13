# Politics Phase Closeout — 2026-03-13

## A. Execution Check

| Item | Status | Observed evidence now | What changed in this run | Caveats |
|---|---|---|---|---|
| Kalshi discovery exists | YES | `scripts/discovery/pmci-discover-kalshi-series.mjs` and `scripts/discovery/pmci-discover-kalshi-politics-series.mjs` present and runnable. | Added maintainable derivation workflow script: `scripts/audit/pmci-refresh-politics-series-config.mjs`. | Discovery quality varies by endpoint + rate limits; needs periodic review.
| Politics series config is no longer opaque legacy blob | PARTIAL | Existing `.env` still carries legacy compact tickers. | Added generated, reviewable artifacts: `config/pmci-politics-series.generated.json` and `config/pmci-politics-series.env` via `npm run pmci:refresh:series-config`. | Runtime ingest still uses `.env` unless operator applies generated env line.
| Per-series budgeting in universe ingest | YES | `lib/ingestion/universe.mjs` uses `perSeriesBudget = ceil(maxEvents / activeSeriesCount)` and enforces per-series cap + global cap. | Revalidated by running ingest with reset and reading runtime logs (`per_series_budget=87` in override run). | Budgeting works; quality still depends on selected live series.
| Topic signature + state normalization | YES | `node test/matching/topic-sig.test.mjs` passes (`governor_oh_2026`, `senate_tx_2026`). | Revalidated in this run. | None.
| Synonym normalization | YES | `lib/matching/entity-parse.mjs` contains synonym normalization used before entity matching. | Revalidated by code inspection + proposal engine behavior already in place. | No new synonym dictionary changes this run.
| Hard entity gate replaced by soft penalty | YES | `lib/matching/proposal-engine.mjs` applies confidence penalty path when entity overlap is zero (not immediate reject). | Revalidated by code inspection. | Threshold tuning may still need follow-up for governor/president.
| Bipartite/max-weight matching | YES | `lib/matching/scoring.mjs:maxWeightBipartite` and calls from proposer block loops. | Revalidated by code inspection. | None.
| Outcome-level refs (`slug#outcomeName`) | YES | `lib/ingestion/universe.mjs` creates `providerMarketRef = ${slug}#${outcomeName}`. | Revalidated by code inspection + existing data patterns. | Some linked-family hygiene issues still remain.
| Repeatable audit packet command | YES | New command `npm run pmci:audit:packet` generates `docs/reports/latest-politics-audit-packet.json`. | Implemented `scripts/audit/pmci-politics-audit-packet.mjs` + package script. | Packet currently summary-level; can be extended with trend diffs over time.
| Integrity guard: 2028 presidential party poly-only mislabel | YES | Included in audit packet under `integrityWarnings.poly_only_pres_party_with_plausible_kalshi`. Current count: `0`. | Implemented explicit query/check in audit packet script. | Guard is pattern-based; broaden if canonical naming changes.
| Integrity guard: TX-33 / canonical deletion risk | YES | Included in audit packet under `integrityWarnings.tx33_or_house_tx33_unlinked_risk`. Current rows: `kalshi=0, poly=0, linked=0`. | Implemented explicit TX-33/house-tx-33 check in audit packet script; revalidated topic test via `test/matching/tx33.test.mjs`. | No live TX-33 rows currently present, so guard validates path, not active incident.
| Governor/president linkage remediation | PARTIAL | Current link rates still weak (governor 0.000 on both venues; kalshi president 0.000). | Ran focused ingest using generated series config override; identified low live-series yield (`live=3`) as immediate blocker for coverage gain. | Requires better curated live series inputs + possibly stricter structural matching filters before next phase.

## B. Current System State vs Pre-Fix

### Current recomputed state (this run)

From `npm run pmci:audit:packet` (latest JSON at `docs/reports/latest-politics-audit-packet.json`):

- Active Kalshi politics markets: **183**
- Active Polymarket politics markets: **2535**
- Active market link rows: **169**
- Cross-provider families: **71**

By topic (active/open):

- **Governor**
  - Kalshi: total 15, linked 0, rate **0.000**
  - Polymarket: total 481, linked 0, rate **0.000**
- **Senate**
  - Kalshi: total 24, linked 13, rate **0.542**
  - Polymarket: total 362, linked 12, rate **0.033**
- **President**
  - Kalshi: total 12, linked 0, rate **0.000**
  - Polymarket: total 482, linked 73, rate **0.151**
- **Other**
  - Kalshi: total 132, linked 28, rate **0.212**
  - Polymarket: total 1210, linked 4, rate **0.003**

### Delta vs known pre-fix baseline

Known pre-fix baseline: ~65 Kalshi events with very narrow linkage.

Current delta:
- Kalshi active politics universe is materially larger (**183 vs ~65**).
- Cross-provider linked families exist at non-trivial volume (**71**), not just a minimal nominee-only state.
- However, linkage remains concentrated and uneven; governor/president categories are still under-linked relative to target-phase expectations.

### Focused QA sample of current links

Sample extracted from audit packet (`sampleLinks`) indicates mixed quality:

1. `SENATEWV-26-D` ↔ `west-virginia-senate-election-winner#Democrat`  
   - Office: aligned (senate)  
   - Geography: aligned (WV)  
   - Cycle: aligned (2026)  
   - Round/outcome: aligned (party winner)

2. `KXPRESNOMR-28-DJTJR` ↔ `presidential-election-winner-2028#Donald Trump Jr.`  
   - Office: aligned (president)  
   - Geography: national (aligned)  
   - Cycle: aligned (2028)  
   - Round mismatch risk: nominee vs winner framing

3. `KXONTPARTY-25-GREEN` ↔ `colombia-chamber-of-representatives-election-winner#Green Alliance`  
   - Office/geography mismatch (Ontario vs Colombia)  
   - Indicates residual structural false-positive hygiene issue.

4. `KXSENATEMED-26-*` ↔ `maine-democratic-senate-primary-winner#...` (multiple)  
   - Some appear aligned (Maine senate primary), but sample also shows candidate cross-pairing noise in same family.

Interpretation: matching architecture is improved, but family-level review/acceptance hygiene still allows structural oddities in a subset of links.

## C. Remaining Changes to Reach Target State

1. [ ] **Apply generated series config into runtime ingestion path**  
   Use `config/pmci-politics-series.env` as the source for `PMCI_POLITICS_KALSHI_SERIES_TICKERS` in scheduled runs (or sync into managed env).  
   Validation: rerun ingest + audit packet; verify `eventsPerSeries` shows broader live political families.

2. [ ] **Curate series derivation ranking to emphasize US election overlap quality**  
   Current generated list produced low usable live-series yield in reset ingest. Add stronger filters/ranking (US election series, overlap-friendly offices/years) to reduce noise.  
   Validation: ingest log `live-series filter enabled live=N` should rise with meaningful senate/governor/president families.

3. [ ] **Tighten structural acceptance hygiene for linked families**  
   Existing links include geography/office mismatches in sample. Add/strengthen review guardrails before acceptance for cross-country/cross-office mismatches.  
   Validation: QA sample should contain zero obvious geography-office mismatches.

4. [ ] **Improve governor/president link rates or explicitly close as venue-shape limited**  
   Investigate whether low rates are due to true market-shape mismatch vs thresholding/config limitations. Fix if deterministic.  
   Validation: measurable increase in governor/president link rates, or signed deferral with evidence of true absence/mismatch.

5. [ ] **Optional: trend snapshots for audit packet**  
   Persist packet history (timestamped JSON) and show drift (counts/rates delta) to make closeout re-validation faster.

---

### Commands executed in this run (closeout-relevant)

- `npm run -s pmci:refresh:series-config`
- `npm run -s pmci:audit:packet`
- `npm run -s pmci:audit:packet -- --strict`
- `PMCI_POLITICS_MAX_EVENTS_PER_PROVIDER=260 PMCI_POLITICS_KALSHI_MAX_EVENTS=260 npm run -s pmci:ingest:politics:universe -- --reset` (with generated env sourced)
- `node test/matching/topic-sig.test.mjs`
- `node --test test/matching/tx33.test.mjs`
- `npm run -s pmci:probe`
