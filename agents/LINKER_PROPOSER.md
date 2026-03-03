# LINKER_PROPOSER — Propose equivalent and proxy links (politics, heuristics)

**Role:** You implement and operate the **proposer** that generates EQUIVALENT and PROXY link suggestions for politics. You consume unlinked provider markets, apply blocking and scoring heuristics, and write to `pmci.proposed_links`. You do not implement the review UI or execution—only candidate generation and gating.

**Scope:** politics only; heuristics-first (no ML training); deterministic, auditable reasons JSON. No trading/execution.

---

## Inputs you expect

- **Required:** Current goal (e.g. "add topic block", "tune equivalent threshold", "cap proxy per block").
- **Optional:** `scripts/pmci-propose-links-politics.mjs`, `pmci.provider_markets`, `pmci.v_market_links_current`, env caps (PMCI_MAX_PROPOSALS_*).
- **Optional:** Sample of proposed_links rows or run logs.

---

## Contract (Phase 2)

### Candidate pool
- **Only unlinked markets:** `provider_markets.id` NOT IN (select provider_market_id from pmci.v_market_links_current).
- **Pools:** A = unlinked kalshi politics; B = unlinked polymarket politics.
- **No all-vs-all:** Compare only within blocks (entity/topic keys).

### Blocking
- **Entity/topic tokens:** From provider_market_ref (e.g. Polymarket `slug#outcomeName` → outcomeName as entity); from title (e.g. Kalshi "Will &lt;NAME&gt; …").
- **Topic dictionary (politics):** fed chair, shutdown, nuclear deal, nominee, senate, house, election, impeachment, etc.
- **Proxy guardrail:** Only generate proxy proposals within a topic block OR with strong entity match.
- **Caps (env):** PMCI_MAX_PROPOSALS_EQUIV (default 200), PMCI_MAX_PROPOSALS_PROXY (default 200), PMCI_MAX_PER_BLOCK (default 50). Stop when caps hit; log that caps were hit.

### Features (reasons JSON)
- title_similarity (0..1), entity_match (bool + matched_tokens), slug_similarity (0..1), time_delta_hours, structure_hint, freshness (last_seen_at), price_source flags from latest snapshot raw._pmci.price_source.

### Scoring and gating
- **Equivalent:** confidence >= 0.985 → auto-accept (create family + links, record decision=accepted, review_decisions note "auto-accepted"). 0.92 <= confidence < 0.985 → insert proposal (decision null).
- **Proxy:** 0.88 <= confidence < 0.97 → insert proposal (decision null). Never auto-accept proxy in v1.

### Family creation (deterministic)
- If either market ties to existing canonical_event (slug match to pmci.canonical_events.slug), attach canonical_event_id.
- Label: `politics::<topic_key>::::<entity_key>`.
- Notes: both provider_market_refs + reason summary.

### Output summary
- proposals_written_equivalent, proposals_written_proxy, autoaccepted_equivalent, skipped_already_linked, skipped_low_confidence, [caps_hit log if applicable].

---

## Execution mode (Claude Code)

**Pre-flight (run before producing artifact):**
- `npm run pmci:probe` — get current unlinked market counts
- `npm run pmci:check-coverage` — see which markets are unlinked (input pool for proposer)
- `npm run pmci:check-proposals` — see current proposal queue state

**Files to read:**
- `scripts/pmci-propose-links-politics.mjs` — current proposer implementation
- `supabase/migrations/20260301000001_pmci_proposals.sql` — proposals schema

**Verification (run after implementation):**
- `npm run pmci:propose:politics` — run proposer, check summary output (proposals_written_equivalent, autoaccepted_equivalent)
- `npm run pmci:check-proposals` — confirm proposals appeared in queue
- `npm run pmci:smoke` — confirm no regression

---

## Definition of done (for this agent)

- [ ] Proposer script runs and writes to pmci.proposed_links with category=politics.
- [ ] Blocking prevents all-vs-all; caps are enforced and logged.
- [ ] reasons JSON is deterministic and auditable.
- [ ] Auto-accept only for equivalent >= 0.985; proxy never auto-accepted in v1.
