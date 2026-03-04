# Cursor Prompt: Matching System Phase 0 + Template Adapters
> Generated: 2026-03-04
> Agents: @Codebase @Terminal

You are implementing a phased improvement to the **PMCI cross-venue market matching system** in this Node.js + Supabase project. The system ingests prediction markets from Kalshi and Polymarket, generates candidate cross-venue match proposals, and routes them to a human review queue.

**Do not** change database migrations, the observer loop (`observer.mjs`), or the API (`src/api.mjs`) unless explicitly instructed below.

---

## Step 1 — Understand the current proposer (read only)

Read these files in full before writing any code:

- `scripts/pmci-propose-links-politics.mjs` — the main proposal generator. Understand how it scores candidate pairs and what data it stores in `proposed_links`.
- `lib/pmci-ingestion.mjs` — ingestion utilities, particularly the `ingestProviderMarket` function and the `reasons` JSONB pattern.
- `supabase/migrations/` — read the most recent migration that created `pmci.proposed_links` to understand the current schema of that table.

After reading, identify:
1. Where the scoring signals are computed (title similarity, entity overlap, etc.)
2. What is currently stored in the `reasons` column of `proposed_links`
3. Whether a `features` column already exists on `proposed_links`

---

## Step 2 — Add feature vector logging to the proposer (Phase 0 of Strategy C)

**Goal**: Store the raw scoring feature vector alongside every `proposed_links` row so that accept/reject decisions passively accumulate labeled training data.

**Task A — Schema check**:
- If `proposed_links` does NOT have a `features` JSONB column, create a new migration file in `supabase/migrations/` that adds it:
  ```sql
  ALTER TABLE pmci.proposed_links ADD COLUMN IF NOT EXISTS features JSONB;
  ```
  Name the file with the next sequential number and a descriptor like `_add_proposed_links_features.sql`.

**Task B — Update the proposer**:
- In `scripts/pmci-propose-links-politics.mjs`, wherever the proposer builds the object to insert into `proposed_links`, add a `features` key containing the raw signal values as a JSONB object. Use this shape:
  ```json
  {
    "title_jaccard": 0.71,
    "entity_overlap": 1.0,
    "date_delta_days": 0,
    "price_spread": 0.03,
    "outcome_name_match": 1.0,
    "confidence_raw": 0.94,
    "template": null
  }
  ```
- `title_jaccard`: Jaccard coefficient of title token sets (already computed; expose it).
- `entity_overlap`: fraction of entity tokens from one title found in the other.
- `date_delta_days`: absolute difference in days between resolution dates, if both are available; null otherwise.
- `price_spread`: absolute difference in `price_yes` between the two markets' latest snapshots, if both available; null otherwise.
- `outcome_name_match`: 1.0 if outcome names are an exact string match after normalization, 0.5 if substring match, 0.0 otherwise.
- `confidence_raw`: the pre-threshold confidence score already computed.
- `template`: leave null for now (will be populated in Step 4).

Do not change the existing `reasons` column — keep it as-is. `features` is a separate, machine-readable column.

---

## Step 3 — Create a template adapter module

**Goal**: Build a pluggable classification layer that identifies the market type (template) for any provider market, and extracts its key matching fields. This enables better blocking and lays the groundwork for future domain adapters.

**Create a new file**: `lib/pmci-matching-adapters.mjs`

This module should export:

```js
/**
 * Classify a provider market into a template type.
 * Returns one of the known template strings, or 'unknown'.
 *
 * @param {object} market - A pmci.provider_markets row or equivalent shape:
 *   { provider_market_ref, title, category, metadata, event_ref }
 * @param {string} venue - 'kalshi' | 'polymarket'
 * @returns {string} template name
 */
export function classifyMarketTemplate(market, venue) { ... }

/**
 * Extract key matching fields for a market given its template.
 * Returns a normalized object used for blocking and scoring.
 *
 * @returns {{ template, jurisdiction, cycle, party, candidateName, resolutionYear, thresholdValue, thresholdAsset }}
 */
export function extractMatchingFields(market, venue) { ... }
```

**Template names to implement**:

| Template | Detection heuristic |
|---|---|
| `election-winner-binary` | ref contains `#SomeName` AND title contains "win" or "nominee" |
| `election-party-binary` | outcome name is "Democrat" or "Republican" or title contains "party" or "control" |
| `primary-nominee` | title contains "primary" or "nominee" and a state/race name |
| `policy-event` | title or ref contains "shutdown", "debt ceiling", "rate decision", "fed" |
| `geopolitical-event` | title contains "iran", "venezuela", "strait", "strike", "supreme leader" |
| `unknown` | fallback |

**Jurisdiction extraction** (for blocking):
- US states: map state abbreviations and full names (TX, Texas, NC, Kansas, Maine) to a normalized code.
- Federal: "US", "federal", "White House", "Senate", "Congress" → `us-federal`.

**Election cycle extraction**: extract 4-digit year from title or ref. If "midterm" appears, map to `2026`. If "presidential" and no year, default `2028`.

**Candidate name extraction**:
- Kalshi: last segment of ticker after the final `-` (e.g., `KXSENATEMED-26-GRA` → `GRA`). Treat as opaque code.
- Polymarket: `#CandidateName` suffix on `provider_market_ref` (already implemented).

---

## Step 4 — Wire template classification into the proposer

In `scripts/pmci-propose-links-politics.mjs`:

1. Import `classifyMarketTemplate` and `extractMatchingFields` from `lib/pmci-matching-adapters.mjs`.
2. When loading provider markets from the DB, classify each market and store the result in a local map keyed by market ID.
3. Update the blocking logic: only generate cross-venue candidate pairs where both markets share the same `(template, jurisdiction, cycle)` tuple. Markets with `template = 'unknown'` on either side still use the existing fallback logic — do not regress coverage.
4. Populate the `template` field of the `features` JSONB when inserting into `proposed_links`.

---

## Step 5 — Verify

After making changes:

1. `npm run pmci:smoke` — must exit 0.
2. `npm run pmci:propose:politics` — verify it completes without errors and proposal count is reasonable (should not drop significantly from ~51).
3. Query the DB to confirm `features` is populated on new rows:
   ```sql
   SELECT id, features FROM pmci.proposed_links ORDER BY created_at DESC LIMIT 5;
   ```
4. Confirm `features` contains the expected keys (title_jaccard, entity_overlap, outcome_name_match, template, etc.).
5. `npm run pmci:probe` — verify counts are stable.

Do not commit until all five checks pass.

---

## Out of scope for this session

- Training or running the logistic regression model (requires ~200 labeled pairs).
- Changes to `src/api.mjs` or the review queue UI.
- Adding new Kalshi or Polymarket ingestion coverage.
- Sports or crypto domain adapters.
