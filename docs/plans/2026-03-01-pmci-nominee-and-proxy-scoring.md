# PMCI: Polymarket Nominee Universe + Proxy Scoring

> **Goal:** (1) Get Polymarket nominee/elections markets into the universe and classify as `topic_key=nominee`. (2) Improve proxy scoring so high-quality pairs in "other" can clear ≥0.88 without lowering thresholds globally.

## Follow-up: Topic signature + generic entity filter (2026-03-01)

To stop nonsensical proxy pairs (e.g. Ann Arbor mayor ↔ Texas senate “Person F”), the proposer was patched to:

1. **Topic signature (blocking)**  
   `extractTopicSignature()` returns `office::geo::year` (e.g. `pres_nominee_us_2028`, `senate_tx_2026`, `house_ga14_2026_special`, `mayor_ann_arbor_2026`). Block key = signature or fallback `topic_key`. Pairs are only considered within the same block.

2. **Generic entity filter**  
   Outcomes like “Person F”, “Individual X”, “Party B” (and single-letter or placeholder tokens) set `entity_quality` to generic. For **proxy** only, the entity gate requires both sides to be non-generic; equivalent proposals are unchanged.

3. **Logging**  
   Per-block stats: `pairs_considered`, `pairs_passed_entity_gate`, `pairs_filtered_generic`. Top 5 proxyConf per block (non-generic only). Total `filtered_generic_entities` logged.

**Result:** `pres_nominee_us_2028` is now a dedicated block (22 Kalshi unlinked, 260 Poly unlinked). If `pairs_passed_entity_gate` is 0 there, Poly outcome names may be “Yes”/“No” or IDs rather than candidate names; fix ingestion or entity extraction for that event type if needed.

---

## Implemented (2026-03-01)

### Task 1: Polymarket nominee universe

**1A) Slug keyword fetch**

- **File:** `scripts/pmci-ingest-politics-universe.mjs`
- **Env:** `PMCI_POLITICS_POLY_SLUG_KEYWORDS="nominee,primary,presidential,2028"` (optional, comma-separated).
- If set, after collecting slugs from `tag_id`, the script calls Gamma `GET /public-search?q={keyword}` for each keyword, merges event slugs into the slug set (deduped), then fetches full events by slug as before. This pulls in nominee-style events that may not appear under the politics tag.
- **Doc:** Env and step documented in script header.

**1B) Robust nominee classification**

- **File:** `scripts/pmci-propose-links-politics.mjs`
- **Change:** In `extractTopicKey()`, added an early check: if title or `provider_market_ref` contains (word-boundary) `nominee`, `primary`, `presidential`, or `2028`, return `'nominee'`. So markets already in the DB (e.g. 468 with nominee/2028 per sanity check) now classify as nominee.

### Task 2: Proxy scoring (keep thresholds)

- **File:** `scripts/pmci-propose-links-politics.mjs`
- **New features:**
  - **keyword_overlap_score:** Jaccard over shared politics keyword set (`PROXY_POLITICS_KEYWORDS`: fed, chair, nominee, ban, tariff, meet, putin, zelenskyy, etc.) between the two markets’ title+ref tokens.
  - **entity_strength:** 1 if last-name match, else 0.7 if entity match, else 0.
  - **topic_match_bonus:** +0.1 (same topic).
  - **time_window_bonus:** +0.05 if both have `close_time` and difference ≤ 60 days.
- **Formula:** Proxy confidence = `equivConf * 0.85 + kwScore * 0.15 + entityStrength * 0.1 + topicMatchBonus + timeWindowBonus`, then existing sharedTopics bonus; cap 0.97. Less weight on slug similarity for proxy.
- **Reasons:** `reasons` object now includes `keyword_overlap_score`, `entity_strength`, `topic_match_bonus`, `time_window_bonus` for debugging/audit.
- **Debug log:** After each topic’s pairing, the script logs the **top 5 proxyConf pairs** for that topic (even if below 0.88), with refs and title snippets.

### Sanity check script

- **File:** `scripts/pmci-count-poly-nominee.mjs`
- **Usage:** `node scripts/pmci-count-poly-nominee.mjs`
- **Output:** Count of Polymarket `provider_markets` where title or ref contains `nominee` or `2028`. Use to confirm whether nominee markets exist in DB (if 0, expand ingestion; if >0 but `poly_all_by_topic.nominee=0`, check `extractTopicKey`).

---

## Definition of done (validation)

- **After universe ingestion:** `poly_all_by_topic.nominee > 0` (or at least Polymarket has nominee markets classified). Run ingestion with `PMCI_POLITICS_POLY_SLUG_KEYWORDS="nominee,primary,presidential,2028"` if tag-only feed lacks them.
- **After proposer:** `proposals_written_proxy > 0` **or** logs show top proxyConf pairs per topic approaching threshold with the new features, and reason (e.g. keyword_overlap_score, entity_strength) is visible in reasons.
- **Review queue:** Review queue returns proposals for human/validation agent.

---

## Quick commands

```bash
# Sanity check: do we have Polymarket nominee/2028 markets in DB?
node scripts/pmci-count-poly-nominee.mjs

# Ingest with slug keywords (optional)
PMCI_POLITICS_POLY_SLUG_KEYWORDS="nominee,primary,presidential,2028" node scripts/pmci-ingest-politics-universe.mjs

# Proposer (uses new extractTopicKey + proxy scoring + top-5 debug log)
node scripts/pmci-propose-links-politics.mjs
```
