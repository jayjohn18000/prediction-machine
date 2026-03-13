# Politics Final Checks (Governor/President) — 2026-03-13

## A. Governor/President Bottleneck Diagnosis

### Governor

- **Coverage status**
  - Expected governor series are present in active Kalshi markets (15 governor-classified markets).
  - Polymarket governor universe is present (523 open governor-classified markets).
  - Drop-off was not ingestion absence; it was matching flow + topic derivation for compact Kalshi tickers.

- **Matching-flow status**
  - Before fix, `GOVPARTYRI-26-*` compact ticker form was not parsed into a concrete governor state-year signature, producing poorer block quality (`governor_unknown_*`).
  - Governor dry-run showed many considered pairs but all low-confidence skips (`skipped_low_confidence=38`) and no proposals written.
  - After compact-ticker signature fix, governor-specific block improved (`governor_ri_2026` visible), and proposer produced an autoaccepted path (`autoaccepted_equivalent=1`, new pair write path active).

- **Main rejection/failure reasons**
  - Compact ticker signature miss for governor family/year (`GOVPARTYXX-YY`) reduced matching quality.
  - Remaining governor pool still has high structural heterogeneity (party-winner vs candidate-primary/winner market shapes), causing low-confidence suppression for most pairs.

- **Classification**
  - Primary issue type: **grouping/topic-derivation + structural mismatch in residual pool**.

### President

- **Coverage status**
  - Kalshi president universe is present and linked.
  - Polymarket president universe is present and linked.

- **Matching-flow status**
  - Matching itself was already functioning (pres proposer dry-run showed attach/new-pair outputs and high proxy/equivalent confidences).
  - The blocker was mostly **measurement/classification drift**: `KXPRESNOM*` + `Presidency` phrasing was undercounted in the audit/probe topic bucketing.

- **Main rejection/failure reasons**
  - Not a proposer failure; mostly reporting taxonomy issue in topic-rate calculations.

- **Classification**
  - Primary issue type: **metric classification / counting logic**.

## B. Changes Made and Validation Results

### Files changed

- `lib/matching/proposal-engine.mjs`
  - Added compact ticker parsing for:
    - `GOVPARTY<STATE>-<YY>`
    - `SENATE<STATE>-<YY>`
  - Added targeted minimum-confidence relaxation by block (`governor_*` and `pres*/nominee*`) to avoid over-pruning valid near-misses.

- `scripts/audit/pmci-politics-audit-packet.mjs`
  - Improved topic bucketing for governor/president/senate using metadata office + ticker patterns (`KXGOV*`, `KXPRES*`, `KXSENATE*`) + `presidency` title token.

- `scripts/ingestion/pmci-ingestion-probe.mjs`
  - Same topic bucketing fixes so `pmci:probe` reports gov/pres accurately.

- `test/matching/topic-sig.test.mjs`
  - Added regression assertions for compact ticker forms:
    - `GOVPARTYRI-26-D`
    - `SENATEWV-26-R`

### Commands run

- `node test/matching/topic-sig.test.mjs`
- `npm run -s pmci:propose:politics -- --dry-run --market governor --explain`
- `npm run -s pmci:propose:politics -- --market governor`
- `npm run -s pmci:audit:packet -- --strict`
- `npm run -s pmci:probe`

### Tests/checks passed/failed

- Passed:
  - topic signature regression test (including compact forms)
  - strict audit packet command
  - governor proposer execution (non-dry) completed without runtime error

- Failed/remaining gate pressure:
  - `pmci:probe` D6 warning remains because governor link rate is still below 0.20

### Before vs after metrics (gov/pres)

- **Governor (Kalshi)**
  - Before: linked **0/15** (0.000)
  - After: linked **1/15** (0.067)

- **President (Kalshi)**
  - Before (misclassified): linked **0/12** (reported)
  - After (correct classification): linked **28/44** (0.636)

### QA sample (gov/pres)

1. `GOVPARTYRI-26-R` ↔ `rhode-island-governor-winner-2026#No`
   - Office: aligned (governor)
   - Geography: aligned (RI)
   - Cycle: aligned (2026)
   - Round: general winner framing
   - Outcome alignment: **questionable** (`Republican` vs `No` binary encoding)
   - Mismatch type: outcome semantic ambiguity (needs stricter outcome mapping guard)

2. `KXPRESNOMR-28-DJTJR` ↔ `presidential-election-winner-2028#Donald Trump Jr.`
   - Office: aligned (president)
   - Geography: aligned (US)
   - Cycle: aligned (2028)
   - Round alignment: **nominee vs general winner mismatch risk**
   - Outcome alignment: person-aligned

3. `KXPRESNOMD-28-DJOH` ↔ `presidential-election-winner-2028#Dwayne 'The Rock' Johnson`
   - Office/geography/cycle: aligned
   - Round alignment: nominee vs winner mismatch risk
   - Outcome alignment: person-aligned

## C. Final Phase Classification

**PHASE PARTIALLY COMPLETE**

### Remaining exact blocker(s)

1. **Governor quality still below completion gate**
   - Link rate is now non-zero, but only **0.067** and the primary new governor link shows outcome semantic ambiguity (`Republican` vs `No`).

2. **Round/market-shape integrity for president links still needs explicit guardrail**
   - Existing links can pair nominee framing to general winner framing; this is structurally risky for strict closeout quality.

### Smallest next required fix

Add a narrow acceptance guard for gov/pres link finalization:
- enforce outcome semantics (party token should not map to `No`/`Yes` without explicit polarity mapping), and
- enforce phase compatibility (nominee vs winner) unless relationship is explicitly `proxy` with lower confidence bucket.

Validation for next fix:
- rerun `pmci:propose:politics -- --market governor` and `--market pres`;
- rerun `pmci:audit:packet -- --strict`;
- confirm governor linked sample has no party-vs-No ambiguity and president sample has explicit phase-consistent relationships.
