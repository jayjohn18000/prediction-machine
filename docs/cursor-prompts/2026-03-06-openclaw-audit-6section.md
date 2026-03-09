# PMCI Cross-Venue Audit — 6-Section Analysis (Revised)
**Date:** 2026-03-06
**Branch:** `chore/infra-hardening-baseline-2026-02-26`
**Scope:** Kalshi ↔ Polymarket politics normalization gap diagnosis and remediation plan
**Epistemic stance:** Openclaw is treated as one noisy sample. All benchmark targets are computed from your own DB and APIs.

---

## Section 1 — High-Level Diagnosis

### What Openclaw saw vs. what you can independently verify

Openclaw produced overlap tables (14 pairs via Oddpool, 81 pairs via direct API). These are **estimates from one methodology**, not ground truth. The "81 cross-platform pairs" figure is constructed from a specific version of Kalshi's API at a specific point in time, using Openclaw's own title-matching logic. It should not be treated as a fixed ceiling to work toward — the actual overlap may be higher or lower depending on:

- Which Kalshi series were active when Openclaw sampled
- Openclaw's own false-positive/false-negative rate (unknown, unvalidated)
- Whether Polymarket markets were open/closed at sample time

**Independent verification strategies (no reliance on Openclaw tables):**

**Strategy A — Bidirectional coverage probe.** For each Kalshi series prefix you ingest (`GOVPARTY-*`, `SENATE-*`, etc.), query Polymarket for the same state + year + race type using known tag mappings. Count how many Kalshi events have ≥1 candidate match on Polymarket. This gives you a *per-series overlap rate* you own entirely.

```sql
-- Self-computed overlap estimate: Kalshi events that have a linked poly market
SELECT
  split_part(pm_k.external_id, '-', 1) AS series_family,
  COUNT(DISTINCT pm_k.id) AS kalshi_events,
  COUNT(DISTINCT ml.secondary_market_id) AS poly_linked,
  ROUND(COUNT(DISTINCT ml.secondary_market_id)::numeric
    / NULLIF(COUNT(DISTINCT pm_k.id), 0), 3) AS overlap_rate
FROM pmci.provider_markets pm_k
LEFT JOIN pmci.market_links ml ON ml.primary_market_id = pm_k.id
WHERE pm_k.provider = 'kalshi' AND pm_k.status = 'active'
GROUP BY 1 ORDER BY 2 DESC;
```

**Strategy B — Temporal consistency check.** Run universe ingest on two consecutive days. For each Kalshi market that appears on both days, check whether any new Polymarket market appeared that could be a match. The rate at which new potential matches appear tells you how dynamic the universe is — which Openclaw's static snapshot cannot capture.

**Strategy C — Provider-native ID cross-reference.** Polymarket slugs often contain race-type strings (`ohio-governor-2026`, `texas-senate-2026`) that you can regex-match against Kalshi series tickers directly, *before* touching titles at all. Count how many Kalshi series tickers have a slug-pattern match on Polymarket. This is a title-agnostic lower-bound estimate.

---

### 3-layer diagnosis (independently verifiable framing)

The system has a **3-layer problem** that compounds from infrastructure down to matching quality. Each layer has a diagnostic you can run yourself.

**Layer 1 (Primary): Static series config — unverified coverage**
`PMCI_POLITICS_KALSHI_SERIES_TICKERS` contains ~80 series. You can independently verify how many are active right now by calling `GET /events?series_ticker={ticker}` for each and counting non-zero results. You do not need Openclaw to tell you that most are expired — run this audit query:

```js
// scripts/pmci-audit-series-activity.mjs
for (const ticker of configuredTickers) {
  const { events } = await kalshi.get(`/events?series_ticker=${ticker}&status=open`);
  console.log(ticker, events.length); // 0 = dead, >0 = live
}
```

The `GOVPARTY-*` and `SENATE-*` series families are entirely absent from the current config. This is verifiable by checking `PMCI_POLITICS_KALSHI_SERIES_TICKERS` for those prefixes — no Openclaw reference needed.

**Layer 2 (Secondary): Topic signature doesn't handle Kalshi series-prefix format**
Verifiable by unit test: assert that `topicSignature('GOVPARTY-OH-2026-REP')` and `topicSignature('ohio governor republican 2026')` produce the same key. Currently they do not.

**Layer 3 (Tertiary): Entity gate and synonym gaps cause silent false rejects**
Verifiable by inspecting your `proposed_links` rejection log: count proposals where `rejection_reason` contains `entity_gate` and both titles reference the same race. Your own rejected proposal data is the ground truth here.

---

## Section 2 — Knowledge and Design Gaps (A–F)

### Gap A: Static series list with no discovery mechanism
**Current:** `PMCI_POLITICS_KALSHI_SERIES_TICKERS` is a hardcoded env var, manually maintained.
**Problem:** Kalshi continuously creates new series. There is no automated mechanism to detect `GOVPARTY-NJ-2025`, `SENATE-TX-2026`, etc. when they go live.

**Self-computed diagnostic:**
```sql
-- Series prefixes present in your DB vs. what you're configured to ingest
-- If a row shows up here with high count, it came from a non-series pathway
-- and may represent undiscovered series
SELECT split_part(external_id, '-', 1) AS prefix, COUNT(*)
FROM pmci.provider_markets
WHERE provider = 'kalshi'
GROUP BY 1 ORDER BY 2 DESC;
```

### Gap B: Event-level max price vs outcome-aligned pricing
**Openclaw behavior:** Uses `max(outcome_prices)` at the event level. For `GOVPARTY-OH-2026` this picks whichever party is currently leading — a party-level price, not a person-level price. Polymarket tracks candidates.
**Your system:** Already corrects this via `providerMarketRef = ${slug}#${outcomeName}`. Do not regress to event-level pricing. The spread comparison must be at the outcome level.

### Gap C: No synonym normalization
**Independently verifiable:** Query your rejected proposals for cases where one title contains `GOP` and the other contains `Republican` — these are false rejects caused by zero token overlap despite identical semantics.

```sql
SELECT id, kalshi_title, poly_title, rejection_reason
FROM pmci.proposed_links
WHERE status = 'rejected'
  AND (kalshi_title ILIKE '%gop%' OR kalshi_title ILIKE '%dem%')
  AND rejection_reason ILIKE '%entity%'
LIMIT 20;
```

### Gap D: Global event cap — ordering bias
**Current:** `universe.mjs` line 207 — global cap across ALL series. Early series in the config string exhaust the budget.
**Self-computed diagnostic:**
```sql
SELECT
  split_part(external_id, '-', 1) || '-' || split_part(external_id, '-', 2) AS prefix,
  COUNT(*) AS ingested
FROM pmci.provider_markets
WHERE provider = 'kalshi'
  AND created_at > NOW() - INTERVAL '1 day'
GROUP BY 1 ORDER BY 2 DESC;
```
If the top prefix accounts for >40% of yesterday's ingest, the cap bias is active.

### Gap E: Checkpoint staleness
**Current:** `KALSHI_CHECKPOINT_PATH` checkpoints are never invalidated for dead series.
**Verifiable:** Inspect the checkpoint file — entries with `lastPage` > 0 for series that now return 0 events are stale.

### Gap F: Greedy matching — globally suboptimal
**Independently demonstrable:** Build a 3-market test fixture: K1 can match P1 (0.90) or P2 (0.60); K2 can only match P1 (0.85). Greedy assigns K1→P1, K2 unmatched. Bipartite assigns K1→P2, K2→P1 — one more match. This is a property of greedy, not an Openclaw claim.

---

## Section 3 — Series Discovery and Ingestion (Option-Sets)

### 3.1 Series discovery — three options

**Option 1: API-driven polling (recommended for simplicity)**
Call `GET /series?category=politics&status=active` (or equivalent) on a weekly schedule. Diff against current config. Output proposed additions for human review.

| | |
|---|---|
| Pros | Zero manual work; catches new series within one week of creation |
| Cons | Depends on Kalshi API exposing a `/series` list endpoint with category filter (verify this exists) |
| Complexity | Low — ~40 lines of script code |

**Option 2: Heuristic ticker construction**
Pre-generate tickers by cross-joining state codes × race types × years: `GOVPARTY-OH-2026`, `SENATE-TX-2026`, etc. Probe each with a HEAD/GET call. Accept those that return ≥1 event.

| | |
|---|---|
| Pros | Works even if no `/series` list endpoint exists; fully deterministic |
| Cons | ~50 states × 5 race types × 3 years = 750 probes per run; API cost/rate-limit risk |
| Complexity | Medium — needs rate limiting, result caching |

**Option 3: Passive accumulation from market snapshots**
Parse the `series_ticker` field on all Kalshi markets you observe via any pathway (spread observer, universe ingest). Any new prefix not in config gets flagged automatically.

| | |
|---|---|
| Pros | Zero extra API calls; self-healing over time |
| Cons | Only discovers series you've already partially ingested — circular if the series was never fetched |
| Complexity | Low — parse existing `pmci.provider_markets.external_id` |

> **If your priority is operational simplicity:** Option 1.
> **If your priority is completeness with no API dependency:** Option 2.
> **If your priority is zero-overhead passive discovery:** Option 3 as a complement to Option 1.

---

### 3.2 Series tier structure (priority ordering)
When multiple series exist, process in this priority order to ensure high-value series get budget:

| Tier | Pattern | Examples | Priority |
|------|---------|----------|----------|
| 1 | `SENATE-*` | `SENATE-OH-2026`, `SENATE-TX-2026` | Highest |
| 2 | `GOVPARTY-*` | `GOVPARTY-OH-2026`, `GOVPARTY-NY-2026` | High |
| 3 | `PRES-*` | `PRES-2028`, `PRES-2032` | High |
| 4 | `HOUSE-*` | `HOUSE-OH-01-2026` | Medium |
| 5 | `MAYOR-*`, `AG-*` | Local/state-level | Low |
| 6 | Everything else | Novelty, international | Lowest |

### 3.3 Per-series budgeting — two options

**Option 1: Equal per-series budget**
```js
const perSeriesBudget = Math.ceil(maxEvents / activeSeries.length);
```

| | |
|---|---|
| Pros | Simple; fair distribution |
| Cons | Wastes budget on small series that have fewer events than the budget |
| Complexity | Trivial |

**Option 2: Proportional budget with minimum floor**
Allocate based on estimated event count (from last run's checkpoint or a probe call), with a minimum of 5 events per series and a maximum of 50.

```js
const totalEstimated = activeSeries.reduce((sum, s) => sum + s.estimatedCount, 0);
const budgets = activeSeries.map(s => ({
  ...s,
  budget: Math.min(50, Math.max(5, Math.round((s.estimatedCount / totalEstimated) * maxEvents)))
}));
```

| | |
|---|---|
| Pros | Large series get proportionally more budget; small series don't waste allocation |
| Cons | Requires a prior-run estimate or probe call per series |
| Complexity | Medium |

> **If your priority is speed/simplicity:** Option 1.
> **If your priority is maximizing coverage of large series:** Option 2.

---

## Section 4 — Matching Design (Option-Sets)

### 4.1 Synonym normalization — three options

**Option 1: Static synonym map (recommended for stability)**
```js
const SYNONYM_MAP = {
  'gop': 'republican', 'dem': 'democratic', 'democrat': 'democratic',
  'democrats': 'democratic', 'republicans': 'republican',
  'pm': 'prime minister', 'sen': 'senator', 'gov': 'governor',
  'rep': 'representative', 'pres': 'president',
  'atty': 'attorney', 'ag': 'attorney general',
};
function normalizeTitle(title) {
  return title.toLowerCase().replace(/\b(\w+)\b/g, w => SYNONYM_MAP[w] || w);
}
```

| | |
|---|---|
| Pros | Deterministic; fast; zero runtime dependencies; easy to audit/extend |
| Cons | Must be manually maintained; will miss novel abbreviations |
| Complexity | Very low |

**Option 2: Embedding similarity (soft matching)**
Embed market titles with a small model (e.g., `text-embedding-3-small`). Use cosine similarity > 0.85 as a synonym signal. Bypass token-level Jaccard entirely for the entity gate.

| | |
|---|---|
| Pros | Handles unseen abbreviations and paraphrasing automatically |
| Cons | Adds API cost (~$0.0001/title) and latency; embedding drift over model versions; harder to debug false matches |
| Complexity | High — requires embedding cache, model pinning, fallback logic |

**Option 3: Hybrid (static map + embedding fallback)**
Run the static map first. If entity gate fails after normalization, optionally query embedding similarity as a fallback signal.

| | |
|---|---|
| Pros | Best of both worlds; embedding only called when rule-based matching is uncertain |
| Cons | Two code paths to maintain |
| Complexity | Medium |

> **If your priority is simplicity and auditability:** Option 1.
> **If your priority is long-term extensibility without manual curation:** Option 2.
> **If your priority is robustness with bounded cost:** Option 3.

---

### 4.2 State code expansion
Expand 2-letter codes before topic signature derivation. This is unambiguously correct — no tradeoff needed.

```js
const STATE_CODES = {
  'oh': 'ohio', 'ny': 'new york', 'tx': 'texas', 'ca': 'california',
  'fl': 'florida', 'pa': 'pennsylvania', 'il': 'illinois', 'ga': 'georgia',
  'mi': 'michigan', 'nc': 'north carolina', 'va': 'virginia', 'az': 'arizona',
  'wa': 'washington', 'ma': 'massachusetts', 'mn': 'minnesota', 'wi': 'wisconsin',
  'co': 'colorado', 'nv': 'nevada', 'nj': 'new jersey', 'mo': 'missouri',
  // ... complete 50-state map
};

function expandSeriesTokens(ticker) {
  return ticker.toLowerCase().split('-').map(t => STATE_CODES[t] || t).join(' ');
}
```

### 4.3 Entity gate — two options

**Option 1: Soft penalty (recommended)**
Replace hard reject with a confidence multiplier. Markets with zero entity overlap survive with reduced confidence and must clear a higher global threshold.

```js
const entityScore = computeEntityOverlap(normalizedA, normalizedB); // 0.0–1.0
if (entityScore === 0) {
  confidence *= 0.4; // strong penalty — most pairs will fall below threshold anyway
} else {
  confidence += entityScore * 0.3;
}
```

| | |
|---|---|
| Pros | Recovers pairs that are correctly normalized but still have no literal token overlap |
| Cons | May allow more false positives into the review queue |
| Complexity | Low |

**Option 2: Keep hard gate, but apply normalization first**
Run synonym + state expansion before the entity check. Only hard-reject if the overlap is zero *after* normalization.

| | |
|---|---|
| Pros | Cleaner logic; easier to debug |
| Cons | Still drops any pair where the normalized titles genuinely share no entity token (can happen with party-level vs. candidate-level framing) |
| Complexity | Trivial — just reorder the pipeline |

> **If your priority is recall (catching more true positives):** Option 1.
> **If your priority is precision (keeping review queue clean):** Option 2.

---

### 4.4 GOVPARTY and SENATE topic signature patterns
Add to `TOPIC_KEY_PATTERNS` in `proposal-engine.mjs`:

```js
// Governor races — handles both Kalshi ticker format and Polymarket title format
{ re: /\bgov(ernor)?\b.*\b([a-z]{2})\b.*\b(20\d{2})\b/i,
  key: (m) => `gov_${expandState(m[2])}_${m[3]}` },
{ re: /\bgovparty-([a-z]{2})-(20\d{2})\b/i,
  key: (m) => `gov_${expandState(m[1])}_${m[2]}` },

// Senate races
{ re: /\bsenate?\b.*\b([a-z]{2})\b.*\b(20\d{2})\b/i,
  key: (m) => `senate_${expandState(m[1])}_${m[2]}` },
{ re: /\bsenate?-([a-z]{2})-(20\d{2})\b/i,
  key: (m) => `senate_${expandState(m[1])}_${m[2]}` },

// Presidential
{ re: /\bpres(ident)?(ial)?\b.*\b(20\d{2})\b/i,
  key: (m) => `president_${m[3]}` },
```

### 4.5 Matching algorithm — three options

**Option 1: Greedy one-to-one (current)**
Sort by score descending, assign highest-scoring Polymarket match to each Kalshi market, remove both from pool.

| | |
|---|---|
| Pros | Fast; simple; already implemented |
| Cons | Not globally optimal — can starve markets that have only one valid match |
| Complexity | Already exists |

**Option 2: Max-weight bipartite matching (recommended for correctness)**
Hungarian algorithm over the per-topic-block score matrix.

```js
// Build weight matrix: rows = kalshiMarkets, cols = polymarkets
const weights = kalshiBlock.map(k => polyBlock.map(p => scorePair(k, p)));
const assignment = maximumWeightMatching(weights); // lightweight impl, <100 lines
const proposals = assignment
  .filter(([ki, pi]) => weights[ki][pi] >= MIN_CONFIDENCE)
  .map(([ki, pi]) => buildProposal(kalshiBlock[ki], polyBlock[pi], weights[ki][pi]));
```

| | |
|---|---|
| Pros | Globally optimal; prevents the K2-goes-unmatched failure case |
| Cons | Slightly more complex to implement (~80 lines for a correct Hungarian impl) |
| Complexity | Medium — trivial at PMCI's market scale |

**Option 3: Learning-based scoring on top of rule system**
Train a small binary classifier (logistic regression or gradient-boosted trees) on your accepted/rejected proposal history. Use it to re-rank or post-filter proposals after the rule-based scorer.

| | |
|---|---|
| Pros | Adapts to your specific proposal patterns; can learn rejection patterns you haven't manually coded |
| Cons | Requires labeled data (you have 162 rejected + 9 accepted — thin but usable); needs retraining as patterns shift |
| Complexity | High for first implementation; medium to maintain |

> **If your priority is correctness with minimal code:** Option 2.
> **If your priority is long-term self-improvement:** Option 3 layered on top of Option 2.
> **If your priority is avoiding new dependencies entirely:** Option 2 (pure JS, ~80 lines).

---

## Section 5 — SQL Safety Rails and Integrity Checks

### 5.1 Prevent mislabeling canonical events as "poly-only"

A canonical event should only be labeled `poly_only` if it has **zero active Kalshi provider_markets**. The failure mode is: a Kalshi market exists but is not linked to the canonical event, so the event appears poly-only by accident.

```sql
-- Alert: canonical events labeled poly_only that have kalshi markets
-- (these are phantom poly-only — the kalshi markets are orphaned, not absent)
SELECT
  ce.id,
  ce.title,
  ce.source_annotation,
  COUNT(pm.id) AS orphaned_kalshi_markets
FROM pmci.canonical_events ce
CROSS JOIN pmci.provider_markets pm
WHERE ce.source_annotation = 'poly_only'
  AND pm.provider = 'kalshi'
  AND pm.status = 'active'
  -- rough title match to surface candidates for manual review
  AND similarity(lower(ce.title), lower(pm.title)) > 0.4
  AND NOT EXISTS (
    SELECT 1 FROM pmci.market_links ml
    JOIN pmci.market_families mf ON mf.id = ml.family_id
    WHERE mf.canonical_event_id = ce.id
      AND (ml.primary_market_id = pm.id OR ml.secondary_market_id = pm.id)
  )
GROUP BY ce.id, ce.title, ce.source_annotation
HAVING COUNT(pm.id) > 0;
```

**Remediation trigger:** If any row appears, surface it in the `pmci:probe` output with label `WARN: poly_only event has orphaned kalshi markets — review for mislabeling`.

---

### 5.2 Prevent accidental deletion of markets that have underlying data

A market should not be deleted or marked inactive if it has:
- snapshots in `provider_market_snapshots`
- accepted links in `market_links`
- pending proposals in `proposed_links`

```sql
-- Alert: markets marked inactive that still have active snapshots or links
SELECT
  pm.id,
  pm.external_id,
  pm.provider,
  pm.status,
  COUNT(DISTINCT pms.id) AS snapshot_count,
  COUNT(DISTINCT ml.id) AS link_count,
  COUNT(DISTINCT pl.id) AS pending_proposal_count
FROM pmci.provider_markets pm
LEFT JOIN pmci.provider_market_snapshots pms ON pms.provider_market_id = pm.id
LEFT JOIN pmci.market_links ml
  ON ml.primary_market_id = pm.id OR ml.secondary_market_id = pm.id
LEFT JOIN pmci.proposed_links pl
  ON (pl.kalshi_market_id = pm.id OR pl.poly_market_id = pm.id)
  AND pl.status = 'pending'
WHERE pm.status = 'inactive'
  AND (pms.id IS NOT NULL OR ml.id IS NOT NULL OR pl.id IS NOT NULL)
GROUP BY pm.id, pm.external_id, pm.provider, pm.status
HAVING COUNT(DISTINCT pms.id) > 0 OR COUNT(DISTINCT ml.id) > 0
    OR COUNT(DISTINCT pl.id) > 0;
```

**Remediation trigger:** Before any bulk status update (`UPDATE provider_markets SET status = 'inactive'`), run this check. If rows appear, require explicit per-row confirmation rather than bulk action.

---

### 5.3 Series coverage dashboard (self-computed)
```sql
SELECT
  split_part(external_id, '-', 1) || '-' || split_part(external_id, '-', 2) AS series_prefix,
  COUNT(*) AS market_count,
  COUNT(*) FILTER (WHERE status = 'active') AS active_count,
  MAX(last_seen_at) AS last_seen
FROM pmci.provider_markets
WHERE provider = 'kalshi'
GROUP BY 1
ORDER BY active_count DESC;
```

### 5.4 Orphaned markets (no family link)
```sql
SELECT pm.id, pm.external_id, pm.title, pm.provider
FROM pmci.provider_markets pm
LEFT JOIN pmci.market_links ml_p ON ml_p.primary_market_id = pm.id
LEFT JOIN pmci.market_links ml_s ON ml_s.secondary_market_id = pm.id
WHERE ml_p.id IS NULL AND ml_s.id IS NULL
  AND pm.status = 'active'
ORDER BY pm.provider, pm.external_id
LIMIT 100;
```

### 5.5 Link coverage by topic (self-computed overlap estimate)
```sql
SELECT
  CASE
    WHEN pm.external_id ILIKE 'GOVPARTY%' OR pm.title ILIKE '%governor%' THEN 'governor'
    WHEN pm.external_id ILIKE 'SENATE%' OR pm.title ILIKE '%senate%' THEN 'senate'
    WHEN pm.external_id ILIKE 'PRES%' OR pm.title ILIKE '%president%' THEN 'president'
    ELSE 'other'
  END AS topic,
  pm.provider,
  COUNT(DISTINCT pm.id) AS total_markets,
  COUNT(DISTINCT ml.id) AS linked_markets,
  ROUND(COUNT(DISTINCT ml.id)::numeric / NULLIF(COUNT(DISTINCT pm.id), 0), 3) AS link_rate
FROM pmci.provider_markets pm
LEFT JOIN pmci.market_links ml
  ON ml.primary_market_id = pm.id OR ml.secondary_market_id = pm.id
WHERE pm.status = 'active'
GROUP BY 1, 2
ORDER BY 1, 2;
```

### 5.6 Proposal rejection pattern analysis
```sql
SELECT
  rejection_reason,
  COUNT(*) AS count,
  ROUND(COUNT(*)::numeric / SUM(COUNT(*)) OVER (), 3) AS pct
FROM pmci.proposed_links
WHERE status = 'rejected'
GROUP BY 1
ORDER BY 2 DESC;
```

### 5.7 Stale series alert
```sql
SELECT
  split_part(external_id, '-', 1) || '-' || split_part(external_id, '-', 2) AS series_prefix,
  MAX(last_seen_at) AS last_seen,
  COUNT(*) AS total_markets
FROM pmci.provider_markets
WHERE provider = 'kalshi'
GROUP BY 1
HAVING MAX(last_seen_at) < NOW() - INTERVAL '7 days'
ORDER BY last_seen ASC;
```

---

## Section 5B — Beating the Auditor

This section describes capabilities Openclaw does not have — structural advantages that make your system more robust and maintainable long-term.

### 5B.1 Richer event typing: primary vs general vs runoff, party vs candidate vs policy

Openclaw treats all markets as undifferentiated "political events." A properly typed schema separates:

| Dimension | Values | Why it matters |
|-----------|--------|----------------|
| `election_phase` | `primary`, `general`, `runoff`, `special` | A Kalshi primary market and a Polymarket general election market are **not** equivalents — price comparison is meaningless |
| `subject_type` | `candidate`, `party`, `policy`, `appointment` | `GOVPARTY-OH-2026` is party-level; a Polymarket "Mike DeWine wins" market is candidate-level — spread comparison requires explicit alignment |
| `resolution_type` | `binary`, `scalar`, `categorical` | Determines valid comparison operations |

**How to add this:** Derive `election_phase` and `subject_type` from series ticker pattern + title during ingestion. Store as columns on `provider_markets`. The proposal engine already has topic signatures — extend them to emit typed metadata.

**Openclaw advantage:** Openclaw has none of this. It compares event-level max prices regardless of phase or subject type. Your system, with typed events, will have a lower false-positive rate and a correct price-comparison alignment mechanism.

---

### 5B.2 Structural schemas for election cycles

Openclaw has no model of the election calendar. Your system can:

- Store a `canonical_election_cycles` table: `{ cycle_year, race_type, state, primary_date, general_date, runoff_threshold }`
- Use this table to validate proposed links: a Kalshi primary market and a Polymarket general market should not be linked as equivalents
- Use `primary_date` and `general_date` to auto-expire active markets that are past their resolution date but not yet marked settled

```sql
CREATE TABLE pmci.election_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_year int NOT NULL,
  race_type text NOT NULL, -- governor, senate, house, president
  state_code char(2),      -- NULL for national races
  primary_date date,
  general_date date,
  runoff_threshold numeric, -- e.g. 0.50 for majority-required states
  notes text
);
```

**Openclaw advantage:** Openclaw has no calendar model. It cannot distinguish "same race, different phase" from "equivalent market." Your system can enforce this as a hard pre-filter.

---

### 5B.3 Venue-native ID / metadata canonicalization before touching titles

Before comparing titles, use venue-native metadata to narrow the candidate set:

**Kalshi:** Series ticker encodes `race_type-state-year-party_or_outcome` in a structured format. Parse this directly into `{ race_type, state, year, outcome }` — no title NLP required for initial blocking.

**Polymarket:** The `groupItemTitle` (outcome name) and slug together encode candidate name and race. Parse the slug pattern `{state}-{race_type}-{year}` as a structured key.

Matching step 1 becomes: join on `(state, race_type, year)` from parsed venue-native IDs. Title comparison is step 2 — only for disambiguation within the same structural block. This eliminates the topic blocking false-reject problem entirely for well-structured series.

```js
// Parse Kalshi ticker to structured key
function parseKalshiTicker(ticker) {
  // e.g. GOVPARTY-OH-2026-REP → { raceType: 'governor', state: 'OH', year: 2026, party: 'REP' }
  const [prefix, stateOrNull, year, ...rest] = ticker.split('-');
  return { raceType: RACE_TYPE_MAP[prefix], state: stateOrNull, year: parseInt(year), suffix: rest.join('-') };
}

// Parse Polymarket slug to structured key
function parsePolySlug(slug) {
  // e.g. ohio-governor-2026 → { raceType: 'governor', state: 'ohio', year: 2026 }
  const match = slug.match(/([a-z-]+?)-(governor|senator|senate|president|house)-(\d{4})/);
  return match ? { state: match[1], raceType: match[2], year: parseInt(match[3]) } : null;
}
```

**Openclaw advantage:** Openclaw uses only title Jaccard. Your structured-key pre-filter eliminates entire categories of false positives/negatives before the title comparison step runs.

---

### 5B.4 Optional learning-based scoring layer

After rule-based scoring produces a confidence float, a lightweight classifier can re-rank proposals before they enter the review queue. Train on your accepted/rejected history:

- Features: `title_jaccard`, `slug_jaccard`, `entity_overlap`, `date_delta_days`, `same_state`, `same_race_type`, `outcome_alignment_score`
- Label: `accepted=1`, `rejected=0`
- Model: logistic regression or gradient-boosted trees — interpretable, fast, no GPU

With 162 rejected and 9 accepted, you have class imbalance but enough signal to reduce review queue noise. Retrain quarterly as the accepted set grows.

**Openclaw advantage:** Openclaw is a static rule system. Your classifier learns from your own review decisions, continuously narrowing the gap between proposal noise and accepted signal.

---

## Section 6 — Phase-Gating Criteria (DB/API-Native Metrics Only)

All gates below are computable purely from your own database and API calls. No dependence on Openclaw's overlap counts.

| Phase | Name | Hard Gate | Soft Gate | How to measure |
|-------|------|-----------|-----------|----------------|
| **D0** | Series Audit | Series activity audit script runs; every configured ticker returns a response (even if 0 events) | ≥2 active `GOVPARTY-*` and ≥2 active `SENATE-*` tickers found | `GET /events?series_ticker={t}&status=open` for each configured ticker |
| **D1** | Universe Ingest | Active Kalshi `provider_markets` count increases by ≥100 after ingest run | New markets include ≥1 `GOVPARTY` and ≥1 `SENATE` prefix | `SELECT COUNT(*) FROM pmci.provider_markets WHERE provider='kalshi' AND status='active'` before/after |
| **D2** | Topic Sig Fix | Unit test: `topicSignature('GOVPARTY-OH-2026-REP')` = `topicSignature('ohio governor republican 2026')` | Zero topic-blocked rejection in probe run for GOVPARTY/SENATE markets | Run `pmci:probe` and inspect `rejection_reason` counts |
| **D3** | Synonym Dict | Unit test: `normalizeTitle('GOP wins')` → `'republican wins'` | Rejected proposals mentioning `gop/dem` with entity_gate reason < 5% of total rejections | `SELECT COUNT(*) WHERE rejection_reason='entity_gate' AND kalshi_title ILIKE '%gop%'` |
| **D4** | Per-Series Budget | No single series prefix accounts for >40% of a single ingest run's new markets | Top-3 series each contribute ≥10% | Coverage dashboard query (Section 5.3) after ingest |
| **D5** | Bipartite Match | Unit test on K1/K2/P1 fixture: bipartite produces 2 matches, greedy produces 1 | Proposal count per topic block ≥ greedy baseline | Add `matchingAlgorithm` field to proposal metadata; compare batch outputs |
| **D6** | Coverage Validation | Self-computed link rate ≥ 20% for `GOVPARTY` + `SENATE` active markets | ≥ 30% link rate for those categories | Link coverage query (Section 5.5) |
| **D7** | Event Typing | `election_phase` and `subject_type` columns populated on ≥80% of active markets | No cross-phase links (primary ↔ general) in `market_links` | `SELECT COUNT(*) FROM provider_markets WHERE election_phase IS NULL AND status='active'` |
| **E** | Sports + Crypto | Phase D6 complete; review queue empty | D7 event typing done | `SELECT COUNT(*) FROM proposed_links WHERE status='pending'` = 0 |

---

## Appendix — Openclaw Reference: What It Is, What It Isn't

Openclaw is one implementation of cross-venue title matching at one point in time. Treat its output as:

- **A lower bound** on cross-venue overlap (it will miss pairs your system catches with better normalization)
- **A noisy sample** (its overlap tables depend on which series were active at sample time)
- **A useful calibration input** (if your system finds significantly fewer pairs than Openclaw on the same market set, investigate)

Do not treat "81 pairs" as the universe size. The actual number of matchable cross-platform markets is a function of which series are currently active on Kalshi and which markets are currently open on Polymarket — a moving target you should measure from your own DB.

| Dimension | Openclaw | PMCI (your system) |
|-----------|----------|-------------------|
| Price alignment | Event-level max | Outcome-aligned `#outcomeName` |
| Matching | Greedy one-to-one | Bipartite optimal (planned) |
| Topic blocking | None | Structured-key pre-filter + topic signatures |
| Synonym handling | None | Static map (+ optional embedding fallback) |
| State codes | None | Expand to full names before signature |
| Series discovery | Manual/static | Automated weekly discovery |
| Event cap | Global (ordering bias) | Per-series budgeted |
| Entity gate | Hard reject | Soft penalty (planned) |
| Event typing | None | `election_phase`, `subject_type` (planned) |
| Election calendar | None | `canonical_election_cycles` table (planned) |
| Venue-native IDs | Not used | Structured ticker/slug parsing (planned) |
| Learning layer | None | Classifier on proposal history (optional) |
