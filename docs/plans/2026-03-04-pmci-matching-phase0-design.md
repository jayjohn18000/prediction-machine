## PMCI Matching Phase 0 — Features & Template Adapter Design

**Goal:** Capture a machine-readable feature vector for every `pmci.proposed_links` row and introduce a pluggable template/matching adapter that classifies provider markets and extracts blocking fields, without regressing current proposer coverage.

### 1. Features logging design

- **Schema**
  - Add `features jsonb` to `pmci.proposed_links` via a forward-only migration:
    - `ALTER TABLE pmci.proposed_links ADD COLUMN IF NOT EXISTS features JSONB;`
  - No additional indexes initially; this column is for offline analysis and model training.

- **Feature vector shape**
  - Stored on every newly inserted `pmci.proposed_links` row:
    - `title_jaccard` — Jaccard similarity of Kalshi title tokens vs Polymarket title tokens (same tokens used for scoring).
    - `entity_overlap` — bucketed overlap in normalized entity tokens (0.0, 0.5, 1.0).
    - `date_delta_days` — absolute difference in close dates in days, or `null` if either side missing.
    - `price_spread` — absolute difference in `price_yes` from latest snapshots, or `null` if either side missing.
    - `outcome_name_match` — 1.0 for exact normalized outcome-name match, 0.5 for substring match, else 0.0; `null` if neither side has an outcome name.
    - `confidence_raw` — the pre-threshold equivalent confidence from `scorePair` (before same-block bonus and auto-accept thresholds).
    - `template` — template name from the adapter (shared `(template,jurisdiction,cycle)` tuple); `'unknown'` when no clear match.

- **Where features are computed**
  - Inside `considerPair` in `scripts/pmci-propose-links-politics.mjs`, after computing:
    - `titleSim`, `slugSim`, `entityMatch`, `sharedTopics`, `keywordOverlapScore`, `entityStrength`, `topicMatchBonus`, `timeWindowBonus`.
    - `rawEquivConf`, `proxy_confidence` via `scorePair`.
    - Same-block/last-name bonus and final `equivalent_confidence`.
  - Use the already-available parsed market fields plus:
    - Close time difference for `date_delta_days`.
    - Latest snapshot `price_yes` values (adding `price_yes` to the snapshot query and caching them in `snapshotRawByMarket`).
    - Simple normalization of Polymarket outcome names and Kalshi binary “Yes” leg for `outcome_name_match`.
  - Build a `features` object and pass it into all `INSERT INTO pmci.proposed_links` calls (auto-accepted equivalent, queued equivalent, and queued proxy).

### 2. Template adapter module

- **Module**
  - New file: `lib/pmci-matching-adapters.mjs`.
  - Exports:
    - `classifyMarketTemplate(market, venue)`
    - `extractMatchingFields(market, venue)`

- **Inputs**
  - `market` is a `pmci.provider_markets`-shaped object:
    - `{ provider_market_ref, title, category, metadata, event_ref, close_time }`.
  - `venue` is `'kalshi'` or `'polymarket'`.

- **Template classification**
  - Use a combined lowercase text view from `title`, `provider_market_ref`, and `event_ref` (with `#` treated as a separator).
  - Detection order (more specific first, to avoid misclassification):
    1. `election-winner-binary`
       - Polymarket: `provider_market_ref` contains `#OutcomeName` AND title contains one of: `"win"`, `"nominee"`, `"primary"`, `"presidential"`, `"election"`.
       - Kalshi: title contains `"Will"` + a name-like token, and election keywords (`"win"`, `"nominee"`, `"primary"`, `"election"`).
    2. `election-party-binary`
       - Outcome name (Polymarket `#outcome`) is `"Democrat"`, `"Republican"`, or `"Yes"`, AND title contains `"party"` or `"control"`.
    3. `primary-nominee`
       - Title contains `"primary"` or `"nominee"` AND a US state (full name or 2-letter code) or district/race token.
    4. `policy-event`
       - Combined text contains any of: `"shutdown"`, `"debt ceiling"`, `"rate decision"`, `"fed"`.
    5. `geopolitical-event`
       - Combined text contains any of: `"iran"`, `"venezuela"`, `"strait"`, `"strike"`, `"supreme leader"`.
    6. Fallback: `'unknown'`.
  - Heuristics are intentionally conservative: when conditions are not clearly met, return `'unknown'` to avoid over-filtering.

- **Matching fields extraction**
  - `extractMatchingFields(market, venue)` returns:
    - `template` — from `classifyMarketTemplate`.
    - `jurisdiction` — normalized code:
      - US states: map state names and 2-letter abbreviations to `us-<stateCode>` (e.g. `us-tx`).
      - Federal: `"US"`, `"federal"`, `"White House"`, `"Senate"`, `"Congress"` → `us-federal`.
      - International: basic country-name detection (e.g. `"Iran"`, `"Venezuela"`) mapped to `intl-<countrySlug>`.
    - `cycle` — election cycle year:
      - Extract 4-digit year from text; if `"midterm"` and no year, use `2026`; if `"presidential"` and no year, default `2028`.
    - `party` — `"democrat"` / `"republican"` when clearly indicated by outcome name or title; else `null`.
    - `candidateName`:
      - Kalshi: last dash-separated token of `provider_market_ref` for election-winner-style markets (opaque candidate code).
      - Polymarket: suffix after `#` in `provider_market_ref` for winner markets.
    - `resolutionYear` — best-effort:
      - Prefer cycle year if present; otherwise, year extracted from `close_time` if available; else `null`.
    - `thresholdValue`, `thresholdAsset` — left `null` for now (will be filled when building rate/threshold templates).

### 3. Wiring adapter into the proposer

- **Preprocessing**
  - In `scripts/pmci-propose-links-politics.mjs`:
    - Import `{ classifyMarketTemplate, extractMatchingFields }` from `lib/pmci-matching-adapters.mjs`.
    - After loading `kalshiAll` and `polyAll` from the database, build maps:
      - `matchingFieldsById: Map<provider_market_id, { template, jurisdiction, cycle, ... }>` using `extractMatchingFields`.
    - When constructing per-block market objects in `addKalshi` / `addPoly`, attach:
      - `template`
      - `matchingFields` (the full extracted object).

- **Blocking**
  - Preserve the existing `blockKey` based on `extractTopicSignature` / `extractTopicKey` to avoid regressions.
  - Before calling `considerPair(k, p, ...)`, apply a template-based gate:
    - If both sides have `matchingFields.template !== 'unknown'`, and both have non-null `jurisdiction` and `cycle`, and the `(template, jurisdiction, cycle)` tuples differ, **skip** the pair.
    - If either side has `template === 'unknown'`, fall back to the existing block-based behavior (no additional filter).

- **Features.template**
  - When building the `features` object for a pair:
    - If both markets share the same non-`'unknown'` template and have aligned `jurisdiction` and `cycle`, set `template` to that value.
    - Otherwise, set `template` to `'unknown'`.

### 4. Non-goals and constraints

- Do **not** modify:
  - Database migrations other than the new `features` column migration.
  - `observer.mjs` or `src/api.mjs`.
- Do **not** change the existing `reasons` column semantics; `features` is strictly additive and machine-oriented.
- Keep proposer output volume similar to the current baseline (~51 proposals for the canonical run), validating via:
  - `npm run pmci:smoke`
  - `npm run pmci:propose:politics`
  - `npm run pmci:probe`
  - Spot-checking the latest `pmci.proposed_links.features` rows.

