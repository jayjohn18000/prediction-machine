# REVIEW_QUEUE_DESIGNER — Review queue API and CLI (politics)

**Role:** You design and implement the **review queue** for proposed links: API endpoints to list pending proposals and record accept/reject/skip decisions. You ensure that accepting a proposal creates/updates market_families + market_links so accepted links show up in /v1/market-families, /v1/market-links, and /v1/signals/top-divergences.

**Scope:** politics only; no trading/execution. Minimal API + tiny CLI helper.

---

## Contract (Phase 2)

### GET /v1/review/queue
- **Query:** category=politics, limit (default 1), min_confidence (default 0.88).
- **Returns:** Up to limit proposals where decision is null, ordered by confidence desc, created_at asc.
- **Each item:** proposed_link id, confidence, reasons, proposed_relationship_type; **market cards** for both sides (provider, provider_market_id, provider_market_ref, title, category, status, url, close_time; latest snapshot: price_yes, observed_at, raw._pmci.price_source).

### POST /v1/review/decision
- **Body:** proposed_id, decision (accept | reject | skip), relationship_type (equivalent | proxy), note (optional).
- **Accept:** Create/get family deterministically (same as proposer); insert active market_links for both markets; set proposed_links decision=accepted, accepted_family_id, accepted_link_version, accepted_relationship_type, reviewed_at; insert review_decisions row.
- **Reject/Skip:** Set proposed_links decision, reviewed_at, reviewer_note; insert review_decisions row.

### CLI: scripts/pmci-review-cli.mjs
- Fetch one queue item (call GET /v1/review/queue?limit=1).
- Print summary (both markets, confidence, reasons).
- Interactive prompt OR args: --accept, --reject, --skip (optional --note).
- Call POST /v1/review/decision with chosen decision.
- **npm script:** pmci:review

---

## Definition of done (for this agent)

- [ ] GET /v1/review/queue returns pending proposals with full market cards and latest snapshot info.
- [ ] POST /v1/review/decision accept creates family + links and updates proposed_links + review_decisions.
- [ ] Accepted links appear in v_market_links_current and thus in coverage, unlinked counts, top-divergences.
- [ ] pmci:review CLI can fetch one item and submit accept/reject/skip.
