# RELATIONSHIP_MANAGER artifact: Schema alignment for proposed links + review queue

**Agent:** RELATIONSHIP_MANAGER  
**Goal:** Decide schema approach for proposed links (equivalent + proxy) and review queue; tie to existing market_families/links and learning loop.  
**Scope:** Cross-cutting schema/API contracts. No implementation.

---

## 1) Recommendation: Option A — add `pmci.proposed_links` table

- **Option A (recommended):** New table `pmci.proposed_links` for all suggestions (equivalent and proxy) with confidence, reasons, and review outcome. Keeps `pmci.market_links` strictly for accepted/active (and historical) links.
- **Option B (rejected for this pipeline):** Reusing `pmci.market_links` with `status = 'proposed'` would mix proposed and accepted rows, complicate `v_market_links_current` (which filters `status <> 'removed'`), and require nullable `family_id` or a synthetic family per proposal. Option A keeps a clear boundary and simpler queries for coverage/divergence.

---

## 2) Required fields for proposed storage

| Field | Type | Purpose |
|-------|------|--------|
| `id` | bigint PK | Identity. |
| `provider_market_id_a` | bigint FK → provider_markets(id) | First market (e.g. Kalshi). |
| `provider_market_id_b` | bigint FK → provider_markets(id) | Second market (e.g. Polymarket). |
| `proposed_relationship_type` | text or enum | `equivalent` \| `proxy`. |
| `confidence` | numeric(5,4) | 0–1 score from proposer. |
| `reasons` | jsonb | Features + scores (title_similarity, entity_overlap, time_window_overlap_hours, etc.); deterministic, auditable. |
| `cohort` / `category` | text | e.g. `politics` or politics subtype; for filtering queue. |
| `created_at` | timestamptz | When proposed. |
| `reviewed_at` | timestamptz nullable | When a decision was recorded. |
| `decision` | text nullable | `accepted` \| `rejected` \| `skipped`. |
| `reviewer_note` | text nullable | Optional note on decision. |

- Constraint: `provider_market_id_a` and `provider_market_id_b` should refer to different providers (e.g. one Kalshi, one Polymarket) to avoid self-links; can be enforced in app or via check.
- Indexes: (category, decision, created_at) for queue; (provider_market_id_a, provider_market_id_b) for dedup/correlation with gold labels.

---

## 3) Review decisions / labels (learning loop)

- **Preferred:** New table `pmci.review_decisions` (or reuse/extend `pmci.link_gold_labels`).
  - **Option 1 — new `pmci.review_decisions`:** One row per review: references `proposed_links.id`, decision (accept/reject/skip), relationship_type applied (if accept), reviewer_note, reviewed_at. Keeps proposed_links as the “suggestion” and decisions as first-class labels for calibration.
  - **Option 2 — link_gold_labels only for accept:** On accept, insert into `link_gold_labels` (provider_a/b, market_a/b, true_relationship). Reject/skip stay only on `proposed_links.decision`. Then we have gold only for accepted pairs; rejected/skipped are still visible on proposed_links for filtering future proposals (e.g. blacklist tokens).
- **Recommendation:** Add `pmci.review_decisions` with columns: `id`, `proposed_link_id` (FK to proposed_links), `decision` (accept/reject/skip), `relationship_type` (nullable; set when accept), `reviewer_note`, `reviewed_at`. This gives a clean audit trail and a single place to compute acceptance rate and feed threshold/weight calibration. Optionally also insert into `link_gold_labels` on accept so linker eval harness can use it.

---

## 4) Migration plan (only if needed)

- **New migration** (e.g. `supabase/migrations/20260228000001_pmci_proposed_links.sql`):
  1. Create `pmci.proposed_links` with the fields above. Use existing `pmci.relationship_type` or a new text field `proposed_relationship_type` (to allow future types without enum change).
  2. Create `pmci.review_decisions` with `id`, `proposed_link_id` (FK to proposed_links), `decision`, `relationship_type`, `reviewer_note`, `reviewed_at`.
  3. Indexes: proposed_links(category, decision, created_at); proposed_links(provider_market_id_a, provider_market_id_b); review_decisions(proposed_link_id).
- **No change** to `pmci.market_links`, `pmci.market_families`, or `pmci.v_market_links_current`. When a review decision is “accept”, the API (or linker) creates/updates a family and inserts rows into `market_links` with status `active` and the chosen relationship_type; `proposed_links.decision` and `reviewed_at` are set, and a row is written to `review_decisions`.

---

## 5) Tie to existing market_families / market_links

- **On accept (review queue):** Create or attach to a `market_family` (e.g. by label derived from proposed link or event_ref), then insert one or two rows into `pmci.market_links` (one per provider_market_id, both pointing to the same family_id, relationship_type from decision, confidence from proposal or fixed, reasons from proposal). Existing `POST /v1/resolve/link` (admin) logic can be reused or refactored into a shared “create family + links from accepted proposal” helper.
- **Coverage / top-divergences:** Only `pmci.market_links` (and `v_market_links_current`) are used; proposed_links do not affect coverage or divergence until accepted and written to market_links.
- **Proposer input:** Reads `pmci.provider_markets` (politics) and existing `pmci.market_links` / `v_market_links_current` (and optionally `proposed_links` with decision=rejected) to avoid re-proposing rejected pairs.

---

## 6) Dependency map (relevant slice)

- **Proposer (Phase 2)** → writes: `pmci.proposed_links`. Reads: `pmci.provider_markets`, `pmci.market_links` / `v_market_links_current`, optionally `pmci.review_decisions` / proposed_links.decision.
- **Review API (Phase 3)** → reads: `pmci.proposed_links`. Writes: `pmci.proposed_links` (decision, reviewed_at), `pmci.review_decisions`, and on accept: `pmci.market_families`, `pmci.market_links`.
- **Calibration / learning loop (future)** → reads: `pmci.review_decisions` (and proposed_links.reasons) to adjust thresholds or weights; must not write to ingestion or execution.

---

## 7) Scope guardrails

- [ ] `pmci.market_links` remains the single source of truth for “linked” markets for coverage and divergence; proposed_links are not used in those queries.
- [ ] Ingestion (observer + universe script) must not write to proposed_links or review_decisions.
- [ ] Any new migration must preserve existing indexes and views on market_links and provider_markets.

---

## 8) Definition of done (for this agent)

- [x] Schema approach chosen (Option A: proposed_links + review_decisions).
- [x] Required fields and migration outline specified.
- [x] Tie to market_families/links and learning loop described.
- [x] No implementation—only relationships and guardrails.
