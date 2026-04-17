# Phase E4: Template-Based Proposer — Execution Plan

## Overview

The current proposer matches markets by title similarity, which works for politics/sports where titles are descriptive ("Will X win the Y election?") but fails for crypto and economics where every market shares the same keywords ("Bitcoin", "Fed rates"). This phase replaces string-similarity matching with **structural template matching**: classify each provider market into a template (e.g. `btc-daily-range`, `fed-rate-decision`), then only propose pairs between compatible templates with aligned parameters (date, asset, strike, meeting). The LLM (Haiku) does classification once per new market pattern; after that, matching is deterministic and zero-cost.

## Prerequisites

- E2/E3 scaffolds committed and cron ingestion active (✅ done)
- `provider_markets` table accessible with ~105K rows
- Anthropic API key available for Haiku classification pass
- Existing proposer code in `lib/matching/proposal-engine.mjs`, `scoring.mjs`, `entity-parse.mjs`, `compatibility.mjs`

## Execution Steps

### Step 1: Add `market_template` and `template_params` columns to `provider_markets`

Create migration adding two columns:
- `market_template TEXT` — canonical template key (e.g. `btc-daily-range`, `fed-rate-decision`, `sports-moneyline`)
- `template_params JSONB` — extracted structured parameters (e.g. `{"asset":"btc","date":"2026-04-14","strike":76000}`)

Index on `(category, market_template)` for proposer queries.

**Files affected:** `supabase/migrations/YYYYMMDD_pmci_market_templates.sql`
**Expected output:** `npm run verify:schema` PASS, new columns visible on `provider_markets`

### Step 2: Define the template vocabulary

Create `lib/matching/templates/` directory with one config file per category:
- `crypto-templates.mjs` — templates like `btc-daily-range`, `btc-price-threshold`, `eth-daily-range`, `crypto-milestone`, `crypto-comparative`
- `economics-templates.mjs` — templates like `fed-rate-decision`, `fed-personnel`, `cpi-threshold`, `gdp-threshold`, `recession-binary`
- `sports-templates.mjs` — re-export existing `classifyMarketTypeBucket` from `sports-helpers.mjs` as the template classifier for sports
- `politics-templates.mjs` — wrap existing `TOPIC_KEY_PATTERNS` from `proposal-engine.mjs` as the template classifier for politics

Each file exports: `classifyTemplate(market) → { template: string, params: object }` using regex/rule-based logic. This is the fast path — no LLM needed for known patterns.

**Files affected:** `lib/matching/templates/*.mjs`
**Expected output:** Unit-testable pure functions, no DB or API calls

### Step 3: Build the Haiku fallback classifier

Create `lib/matching/templates/llm-classifier.mjs`:
- Takes a batch of unclassified market titles + metadata
- Calls Claude Haiku with a system prompt containing the template vocabulary and examples
- Returns `{ template, params }` per market
- Includes response caching: if a title pattern has been seen, skip the API call
- Batch size: 50 markets per API call (structured output)

The prompt should include the full template vocabulary from Step 2 as the allowed output space — Haiku picks from the list, it doesn't invent templates.

**Files affected:** `lib/matching/templates/llm-classifier.mjs`
**Expected output:** Callable module; test with 10 sample markets from each category

### Step 4: Build the backfill script

Create `scripts/classify/pmci-classify-templates.mjs`:
- Reads all `provider_markets` where `market_template IS NULL` in batches of 500
- Runs rule-based classifier first (Step 2); falls back to Haiku (Step 3) for unmatched
- Writes `market_template` + `template_params` back to DB
- Logs classification stats: `{ rule_classified, llm_classified, unclassified, total }`
- Add npm script: `pmci:classify:templates`

**Files affected:** `scripts/classify/pmci-classify-templates.mjs`, `package.json`
**Expected output:** Running `npm run pmci:classify:templates` populates ~105K rows. Target: >90% rule-classified, <10% Haiku, <1% unclassified.

### Step 5: Wire classification into ingestion

Modify the ingest-time upsert path so new markets get classified on arrival:
- In `lib/ingestion/crypto-universe.mjs`, `economics-universe.mjs`, `sports-universe.mjs`: after upsert, call rule-based classifier and write `market_template` + `template_params`
- Haiku fallback only fires if rule-based returns null — this should be rare after backfill establishes the vocabulary
- Add `PMCI_CLASSIFY_ON_INGEST=1` env flag (default on) so it can be toggled

**Files affected:** `lib/ingestion/*-universe.mjs`
**Expected output:** New markets arriving via cron ingest get `market_template` populated automatically

### Step 6: Add template compatibility rules to proposer

Create `lib/matching/templates/compatibility-rules.mjs`:
- Defines which template pairs are proposable (e.g. `btc-daily-range` ↔ `btc-daily-up-down` = yes, `btc-daily-range` ↔ `btc-milestone` = no)
- Defines parameter alignment rules per template pair (e.g. dates must match within 1 day, assets must match exactly, strikes must be within 10%)
- Export: `areTemplatesCompatible(templateA, paramsA, templateB, paramsB) → { compatible: boolean, reason: string }`

**Files affected:** `lib/matching/templates/compatibility-rules.mjs`
**Expected output:** Pure function, unit-testable

### Step 7: Refactor crypto and economics proposers to use template matching

Modify `scripts/review/pmci-propose-links-crypto.mjs` and `pmci-propose-links-economics.mjs`:
- Replace the current approach (fetch all markets → cross-product → score titles) with: fetch markets grouped by `market_template` → only cross-join compatible template groups → score within compatible pairs
- Title similarity scoring still runs but only on pre-filtered pairs — this makes the confidence scores meaningful
- The existing `cryptoAssetBucket` and `cryptoPairPrefilter` in `compatibility.mjs` become redundant (subsumed by templates) — deprecate but don't remove yet

**Files affected:** `scripts/review/pmci-propose-links-crypto.mjs`, `scripts/review/pmci-propose-links-economics.mjs`
**Expected output:** Proposer generates fewer, higher-quality proposals. Confidence scores should be higher because only structurally valid pairs are scored.

### Step 8: Verify end-to-end and tune auto-accept threshold

Run the full chain: `classify → propose → auto-accept → audit` for crypto and economics. Compare proposal quality against the current baseline (the 200 garbage proposals we saw today). Tune `min_confidence` — it may be possible to lower it to 0.5 or even remove it since template compatibility is now the primary gate.

**Files affected:** None (operational verification)
**Expected output:** Crypto and economics active_links count increases meaningfully; zero false-positive accepted pairs

## Verification

- `npm run verify:schema` PASS
- `npm run pmci:smoke` PASS
- `npm run pmci:classify:templates` completes with >90% rule-classified
- `npm run pmci:review:crypto` produces proposals where both titles are structurally related
- `npm run pmci:review:economics` same
- Active link counts for crypto/economics increase from current baseline (1/4 and 2/8)

## Rollback

- Drop `market_template` and `template_params` columns (migration down)
- Revert proposer scripts to pre-template versions
- No other system depends on these columns yet
