# Phase G: Canonical Event Architecture — Execution Plan

## Overview

The current matching system links provider markets directly to each other using fuzzy title/team/date matching, producing a 0.5% link rate (205 linked markets out of 37,200 active) and 62,832 rejected junk proposals. The root cause is threefold: Polymarket's opaque sport taxonomy prevents join-key alignment, market-type bucketing fails when one side has no bucket, and flat market-to-market pairing creates combinatorial explosion.

Phase G replaces this with a two-tier architecture: match **events** first (using external schedule anchors as ground truth), then match **markets within events** deterministically by type. This eliminates the need for human review, fixes the taxonomy problem at the source, and extends matching to crypto, economics, and politics categories that currently have near-zero coverage.

## Context: Why This Over Patching

Fixing sport taxonomy (mapping `itsb` → real sports, `bkfibaqeu` → `nba`, etc.) and fixing Polymarket market-type bucketing would improve the current system, but both fixes fold naturally into the event hierarchy — taxonomy normalization happens during event attachment, and market-type classification happens during market slotting. Building the hierarchy first means we don't patch a system we're replacing.

## Prerequisites

- Supabase project `awueugxrdlolzjzikero` accessible and healthy
- The `pmci.canonical_events`, `pmci.canonical_markets`, `pmci.canonical_outcomes`, `pmci.provider_event_map`, `pmci.provider_market_map`, `pmci.provider_outcome_map` tables already exist (currently 0 rows) — confirm their schema matches Phase G needs or migrate
- External API keys: TheSportsDB (free, no key needed), CoinGecko (free tier), Federal Reserve calendar (public), Google Civic API (free with key)
- Current matching pipeline can be run in parallel during migration (old system stays live until G is validated)

## Execution Steps

### Step 1: Audit and migrate the canonical tables schema

The six canonical/provider-map tables already exist with 0 rows. Read their current column definitions and compare against the schema doc (`phase-g-canonical-events-schema.md`). If columns are missing or types differ, write a migration to alter them. Do not drop and recreate — alter in place so the tables stay connected to any existing RLS policies or indexes.

**Why:** These tables were scaffolded earlier but never populated. They need to match the event hierarchy design before anything else proceeds.

**Files affected:** `supabase/migrations/` (new migration file)
**Expected output:** All six tables match the Phase G schema. `npm run verify:schema` passes.

### Step 2: Build the Polymarket sport taxonomy normalizer

Create a mapping module that translates Polymarket's opaque sport codes (`itsb`, `wwoh`, `bkfibaqeu`, `j1-100`, `j2-100`, `ukr1`, `bkjpn`, `bkaba`, `bkbbl`, `bkbsl`, `bkvtb`, `bkgr1`, etc.) to canonical sport names (`nba`, `nhl`, `soccer`, `basketball`, `mma`, etc.).

For deterministic codes (e.g., `wwoh` → `nhl`, `bkfibaqeu` → `nba`), use a static lookup table. For the `itsb` junk-drawer code (4,188 markets mixing soccer, UFC, cricket, and others), use title-based sport inference — the existing `inferSportFromPolymarketTitle` function should handle most cases.

Run a one-time backfill to update all active Polymarket `provider_markets` rows with corrected `sport` values. Verify by checking that no active market has a sport code that isn't in the canonical sport enum.

**Why:** The matcher currently requires `sport = sport` as the first join key. Kalshi has 5,523 NBA markets under `nba`; Polymarket has the same NBA content split across `basketball` (75) and `bkfibaqeu` (208). Without normalization, these can never match.

**Files affected:** `lib/providers/polymarket.mjs` (or new `lib/normalization/sport-taxonomy.mjs`), backfill script
**Expected output:** Every active Polymarket market has a canonical sport value. Zero rows with codes like `itsb`, `wwoh`, `bkfibaqeu` remaining.

### Step 3: Build the market-type classifier for Polymarket

Polymarket markets arrive with `null` market_bucket values, causing the proposer to generate N×M proposals per game. Build a regex/pattern classifier that assigns market types during ingestion based on Polymarket title patterns:

- `"X vs Y Winner?"` or `"Will X win?"` → `moneyline`
- `"X vs Y: O/U N.5"` or `"Total Runs?"` → `total`
- `"Spread: X (-N.5)"` → `spread`
- `"Both Teams to Score"` → `btts`
- `"Will X win the 2026 World Series?"` → `futures_winner`
- `"Will X win the MVP?"` → `futures_award`

Store this in the `market_template` column on `provider_markets`. Backfill all active Polymarket markets.

**Why:** Without market-type bucketing, the system proposed matching "A's vs NYM Winner?" against "A's vs NYM Total Runs?" and "A's vs NYM first 5 innings winner?" — generating 6+ proposals for the same rough matchup. Market-type is a hard filter that eliminates this explosion.

**Files affected:** `lib/normalization/market-type-classifier.mjs` (new), Polymarket ingestion path, backfill script
**Expected output:** >90% of active Polymarket sports markets have a non-null `market_template`. The remaining ~10% (unusual formats) get `unknown` and are flagged for review.

### Step 4: Build external event schedule ingestors

Create adapters that pull upcoming event schedules from external sources and write them as `canonical_events` rows. Each adapter returns a normalized event record with: sport/category, event date, participants (teams/candidates/assets), event type, and an external reference ID.

**Sports:** TheSportsDB API — pull upcoming games for MLB, NBA, NHL, soccer (major leagues), and other sports Kalshi/Polymarket cover. Map each game to a canonical event with home/away teams, kickoff time, and league.

**Economics:** Scrape/parse the Federal Reserve FOMC calendar and BLS release schedule. Each meeting or data release becomes a canonical event (e.g., "FOMC Meeting 2026-05-05", "CPI Release 2026-05-13").

**Politics:** Google Civic API for election dates. Each race becomes a canonical event (e.g., "2026 Senate GA General Election 2026-11-03").

**Crypto:** CoinGecko API for tracking active assets. Canonical events are price-target deadlines derived from market metadata (e.g., "BTC > $100K by 2026-06-30"). These don't have external schedule anchors — the event is seeded from the first provider market seen, with the settlement date as the anchor.

**Why:** External schedules provide ground-truth event identity. When Kalshi says "Athletics vs New York Yankees" and Polymarket says "A's vs New York M", the external schedule says "Oakland Athletics @ New York Yankees, Apr 14, 7:05 PM ET" — that's the canonical event both attach to. For economics and politics, official calendars eliminate ambiguity. For crypto, settlement dates serve as the anchor since there's no external game schedule.

**Files affected:** `lib/events/` (new directory), one adapter per source
**Expected output:** Canonical events populated for the next 7-14 days of sports, next 90 days of economic releases, active election cycles, and active crypto price targets. Each has an `external_ref` linking back to the source.

### Step 5: Build the event-matching engine (provider market → canonical event)

Replace the current market-to-market proposal engine with an event-first matcher. For each unlinked `provider_market`:

1. **Filter candidates:** Find canonical events matching the market's sport/category + date (±1 day tolerance for timezone issues).
2. **Score attachment:** Compare the market's teams/entities against the event's participants using normalized team names. For sports, team matching is primary. For politics, candidate/race matching. For crypto, asset + price target + settlement date. For economics, release type + date.
3. **Attach or skip:** If confidence ≥ threshold, write a `provider_event_map` row linking the market to the canonical event. If below threshold, route to the low-confidence queue (external to this plan — handled by LLM review).
4. **Market-type slot:** Once attached to an event, the market's `market_template` determines its slot. Two markets from different providers attached to the same canonical event with the same `market_template` are automatically linked as equivalent.

**Why:** This inverts the matching logic. Instead of "find me a Polymarket market that looks like this Kalshi market" (O(n²) fuzzy), it becomes "which canonical event does this market belong to?" (O(n) lookup). Market linking within an event is then deterministic by type.

**Files affected:** `lib/matching/event-matcher.mjs` (new), replaces `lib/matching/proposal-engine.mjs` as the primary matcher
**Expected output:** Provider markets attached to canonical events. Markets sharing an event + market_template are auto-linked into families.

### Step 6: Build the autonomous linking pipeline

Wire the event matcher into the observer loop or a scheduled job so it runs continuously:

1. On each ingestion cycle, new/updated provider markets trigger event matching.
2. New canonical events are pulled from external sources on a schedule (sports: daily, econ: weekly, politics: monthly, crypto: on first market seen).
3. Auto-linking happens when two provider markets from different providers are attached to the same canonical event with the same market_template. This creates/updates `market_links` and `market_families` rows with high confidence and clear audit trail.
4. Markets that don't match any canonical event go into a "no-event" queue. Markets that match an event but have no cross-provider counterpart go into a "single-sided" queue. Both are observable but don't block the pipeline.

**Why:** This replaces the current manual review workflow. The event hierarchy makes linking deterministic enough that human review is unnecessary for high-confidence matches. The low-confidence queue (outside this plan) catches edge cases.

**Files affected:** `observer.mjs` or new cron job in `supabase/functions/pmci-job-runner/`, `lib/matching/auto-linker.mjs` (new)
**Expected output:** Linked families grow automatically as markets are ingested. No manual `POST /v1/review/decision` needed for standard matches.

### Step 7: Migrate existing links and validate

Migrate the current 176 bilateral families and 205 linked markets into the new canonical event structure:

1. For each existing `market_families` row, find or create the corresponding `canonical_event`.
2. Attach the linked `provider_markets` to that event via `provider_event_map`.
3. Verify that the new system would have produced the same links autonomously.
4. Run the new matcher on all 37,200 active markets and compare results against the old system's 117 accepted sports proposals — the new system should find all of them plus many more.

**Why:** Validates that the new architecture reproduces known-good results and surfaces new matches the old system missed.

**Files affected:** Migration script, validation script
**Expected output:** All existing links preserved. New link count significantly higher than 205. A report showing: total canonical events, markets attached, bilateral families formed, link rate by category.

### Step 8: Deprecate the old proposal system

Once Phase G is validated and producing higher link rates:

1. Stop running the old proposer (`npm run pmci:propose:sports` and equivalents).
2. Mark the old `proposed_links` table as deprecated (don't drop — keep for audit).
3. Update the API to serve families from the new canonical event structure.
4. Update the observer to use the new event-matching pipeline exclusively.

**Why:** Clean cutover. The old system stays queryable for historical audit but stops producing new proposals.

**Files affected:** `observer.mjs`, API routes, cron job configuration
**Expected output:** Single matching pathway through the canonical event architecture. Old proposer disabled.

## Verification

- `npm run verify:schema` passes after all migrations
- Link rate audit: query bilateral families / total active markets — target >10% (up from 0.5%)
- Coverage by category: sports, politics, economics, and crypto all have linked families (currently only sports and politics have any)
- Regression check: all 176 existing bilateral families are preserved in the new structure
- No active Polymarket market retains an opaque sport code (`itsb`, `wwoh`, `bkfibaqeu`, etc.)
- Snapshot/spread pipeline still works — `prediction_market_spreads` continues recording observations for linked families

## Rollback

- The old `proposed_links` / `market_links` / `market_families` tables remain untouched until Step 8
- The canonical tables can be truncated without affecting the old system
- Observer can be reverted to the old proposer by toggling a feature flag or env var
- External schedule ingestors are additive — they only write to canonical tables, never modify provider_markets (except sport normalization in Step 2, which is independently valuable and should not be rolled back)
