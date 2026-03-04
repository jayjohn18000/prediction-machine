# PMCI Matching Phase 0 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `features` JSONB column to `pmci.proposed_links`, log a structured feature vector for every new proposal, and introduce a template/matching adapter module wired into the politics proposer for safer blocking.

**Architecture:** Keep all schema changes confined to a single migration file; extend the existing `pmci-propose-links-politics.mjs` script to compute and persist features, and add a new `lib/pmci-matching-adapters.mjs` module for template classification and matching fields. Preserve current behavior and coverage by making template heuristics conservative and falling back to existing topic-key blocking when templates are unknown.

**Tech Stack:** Node.js (ES modules), pg client, Supabase Postgres migrations, plain SQL, existing PMCI proposer scripts.

---

### Task 1: Add features column migration

**Files:**
- Create: `supabase/migrations/20260304120001_pmci_proposed_links_features.sql`

**Step 1: Write migration SQL**

```sql
alter table pmci.proposed_links
  add column if not exists features jsonb;
```

**Step 2: Save migration file**

- Ensure the filename matches the pattern and is ordered after existing PMCI migrations.

**Step 3: Sanity check**

- Run: `ls supabase/migrations` and confirm the new file is present and correctly named.

---

### Task 2: Create pmci-matching-adapters module

**Files:**
- Create: `lib/pmci-matching-adapters.mjs`

**Step 1: Scaffold exports and types**

```js
export function classifyMarketTemplate(market, venue) {
  // implementation
}

export function extractMatchingFields(market, venue) {
  // implementation
}
```

**Step 2: Implement shared helpers**

- Add helpers for:
  - Lowercasing and normalizing text.
  - Detecting US states (names and 2-letter codes).
  - Extracting election cycle year from text (`midterm` → 2026, `presidential` → 2028 default).
  - Extracting basic country names for international jurisdiction.

**Step 3: Implement template classification**

- Implement detection logic for:
  - `election-winner-binary`
  - `election-party-binary`
  - `primary-nominee`
  - `policy-event`
  - `geopolitical-event`
  - Fallback to `'unknown'`.

**Step 4: Implement matching fields extraction**

- Implement `extractMatchingFields` to return:
  - `template`
  - `jurisdiction`
  - `cycle`
  - `party`
  - `candidateName`
  - `resolutionYear`
  - `thresholdValue`
  - `thresholdAsset`

---

### Task 3: Wire template adapter into proposer loading

**Files:**
- Modify: `scripts/pmci-propose-links-politics.mjs`

**Step 1: Import adapter functions**

```js
import { classifyMarketTemplate, extractMatchingFields } from '../lib/pmci-matching-adapters.mjs';
```

**Step 2: Precompute matching fields for provider markets**

- After loading `kalshiAll` and `polyAll`, build:

```js
const matchingFieldsById = new Map();
// populate using extractMatchingFields for each row
```

**Step 3: Attach fields in addKalshi/addPoly**

- When building per-block market objects, attach:
  - `template`
  - `matchingFields`

---

### Task 4: Add template-based blocking without regressing coverage

**Files:**
- Modify: `scripts/pmci-propose-links-politics.mjs`

**Step 1: Implement blocking gate**

- Before calling `considerPair(k, p, block, topicStats, isKalshiSource)` inside the block loops:
  - If both `k.matchingFields` and `p.matchingFields` have non-`'unknown'` `template`, and non-null `jurisdiction` and `cycle`, skip pairs where `(template, jurisdiction, cycle)` differ.
  - If either template is `'unknown'`, fall back to existing behavior (do not skip based on templates).

**Step 2: Keep existing blockKey**

- Do not modify `blockKey` or topic-signature logic; the template gate should be an additional filter only.

---

### Task 5: Add price_yes to snapshot query for feature computation

**Files:**
- Modify: `scripts/pmci-propose-links-politics.mjs`

**Step 1: Extend snapshot query**

- Update the `provider_market_snapshots` query to select `price_yes` in addition to `raw`.

**Step 2: Cache price_yes per market**

- Store both `raw` and `price_yes` in `snapshotRawByMarket` (or a dedicated structure) keyed by `provider_market_id`.

**Step 3: Add getter helper**

- Implement `getPriceYes(pmId)` alongside `getPriceSource(pmId)` that reads from the cached snapshot data.

---

### Task 6: Build and persist features JSONB in considerPair

**Files:**
- Modify: `scripts/pmci-propose-links-politics.mjs`

**Step 1: Compute feature components**

- Inside `considerPair`:
  - Reuse `titleSim` for `title_jaccard`.
  - Derive `entity_overlap` from `k.entityTokens` and `p.entityTokens`, bucketed to 0.0 / 0.5 / 1.0.
  - Compute `date_delta_days` from `k.close_time` and `p.close_time`.
  - Use `getPriceYes(k.id)` / `getPriceYes(p.id)` for `price_spread`.
  - Normalize outcome names (Polymarket `outcomeName`, Kalshi `"yes"`) and compute `outcome_name_match` (1.0 / 0.5 / 0.0).
  - Use `rawEquivConf` from `scorePair` as `confidence_raw`.
  - Use matching fields to compute the pair `template` value for features.

**Step 2: Build features object**

```js
const features = {
  title_jaccard,
  entity_overlap,
  date_delta_days,
  price_spread,
  outcome_name_match,
  confidence_raw,
  template,
};
```

**Step 3: Pass features into all proposed_links inserts**

- Update all `INSERT INTO pmci.proposed_links` statements (auto-accepted equivalent, queued equivalent, queued proxy) to include the `features` column and parameter.

---

### Task 7: Run verification commands and spot-check features

**Files / Commands:**
- Commands run from repo root.

**Step 1: Apply migrations via Supabase tooling**

- If needed in this environment, run: `npx supabase db push` (or rely on existing migration application workflow).

**Step 2: Run PMCI checks**

- Run: `npm run pmci:smoke` — expect exit code 0.
- Run: `npm run pmci:propose:politics` — expect completion without errors and a similar proposal count to the previous baseline (~51).
- Run: `npm run pmci:probe` — expect counts to be stable.

**Step 3: Inspect features contents**

- Run a psql or Supabase SQL query:

```sql
select id, features
from pmci.proposed_links
order by created_at desc
limit 5;
```

- Confirm:
  - `features` is non-null.
  - Keys include `title_jaccard`, `entity_overlap`, `date_delta_days`, `price_spread`, `outcome_name_match`, `confidence_raw`, `template`.

**Step 4: Adjust if necessary**

- If proposal counts drop dramatically or features look obviously wrong, iterate on adapter heuristics and feature calculations conservatively until behavior is stable.

