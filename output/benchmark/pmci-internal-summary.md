# PMCI internal gap analysis — snapshot (regenerate via benchmark)

Run: `npm run pmci:benchmark:coverage`  
Full machine JSON: `output/benchmark/last-run.json` (gitignored).

## Scale (example snapshot — 2026-04-14)

| Slice | Count |
|--------|--------|
| provider_markets total | 80,606 |
| sports | 75,841 |
| politics | 4,643 |
| nominee slug categories | 70 + 52 |
| polymarket / kalshi | ~38.2k / ~42.4k |
| market_families | 3,233 |
| v_market_links_current | 357 |

## Link rate by category (same snapshot)

| category | total_markets | linked_markets | link rate |
|----------|---------------|----------------|-----------|
| sports | 75,841 | 221 | ~0.3% |
| politics | 4,643 | 32 | ~0.7% |
| democratic-presidential-nominee-2028 | 70 | 70 | 100% |
| republican-presidential-nominee-2028 | 52 | 34 | ~65% |

**Interpretation:** PMCI strongly links the **curated 2028 nominee** universes; **broad politics** and especially **sports** remain mostly unlinked at the row level.

## proposed_links decisions (same snapshot)

| decision | count |
|----------|------:|
| rejected | 62,999 |
| accepted | 159 |
| null (pending) | 3 |
| skipped | 2 |

## Sports rejections — `skip_reason` (dominant signal)

Almost all mass rejections are **`market_type_mismatch:*`** (pairing moneyline vs totals, BTTS, spread, etc.), not “bad embeddings”. That is expected given heterogeneous sports contract types across venues.

Top patterns (approximate):

- `market_type_mismatch:moneyline_winner:totals` — tens of thousands  
- `market_type_mismatch:totals:btts`  
- `market_type_mismatch:moneyline_winner:btts`  
- `market_type_mismatch:btts:totals`  
- `market_type_mismatch:moneyline_winner:spread`  

## Rejected confidence buckets

Most rejected rows sit in **0.0–0.1** confidence (bulk low-score sports candidates), with a long tail in 0.8–1.0 for a small set of higher-score rejects (see `rejected_confidence_buckets` in `last-run.json`).

## Matching code — key thresholds (politics path)

From `lib/matching/proposal-engine.mjs` and `lib/matching/scoring.mjs`:

- **Equivalent score** blends title, slug, entity, embedding (`scorePair` in `scoring.mjs`).
- **MIN_CONFIDENCE_AFTER_ENTITY** by block: governor blocks **0.25**, president/nominee **0.40**, default **0.50** — below this, no proposal written.
- **Semantic guard** can block otherwise scoring pairs.
- **Title/slug floor** for equivalent proposals: skip if `title_similarity < 0.30` AND `slug_similarity < 0.20`.
- Caps: `PMCI_MAX_PROPOSALS_EQUIV`, `PMCI_MAX_PROPOSALS_PROXY`, `PMCI_MAX_PER_BLOCK` (env-tunable).

## Observer (latest heartbeat)

The benchmark records `pairs_configured` / `pairs_attempted` / `pairs_succeeded` from `pmci.observer_heartbeats` (one row). Values change with `event_pairs.json`, `OBSERVER_DB_DISCOVERY`, and runtime. See `observer_latest` in `last-run.json`.

## Bottlenecks (summary)

1. **Category coverage:** PMCI ingests **politics + sports** (plus small nominee slices); competitors’ screeners include **economics, crypto, financials, entertainment**, etc.
2. **Sports:** enormous cross-product of **incompatible market types** → reject storm unless matching is stratified by **market_type** first.
3. **Politics:** many Polymarket/Kalshi markets are **not the same contract** even when titles rhyme; PMCI intentionally keeps high precision.
4. **Observer static pairs:** `event_pairs.json` has **31** rows — tight spread-observation footprint vs full PMCI universe.
