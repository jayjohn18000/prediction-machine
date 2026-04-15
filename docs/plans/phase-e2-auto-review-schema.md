# Phase E2: Auto-Review Gate — Schema & Architecture

## Environment Variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PMCI_AUTO_ACCEPT_MIN_CONFIDENCE` | `0.70` | Floor confidence for autonomous acceptance |
| `PMCI_AUTO_ACCEPT_CATEGORIES` | `crypto,economics` | Comma list of categories eligible for auto-accept |
| `PMCI_PORT` | `3001` | Port auto-acceptor uses to call review API |
| `DATABASE_URL` | required | Postgres connection for guard queries |
| `PMCI_API_KEY` | required | Auth header for `/v1/review/decision` |

## Acceptance Guard Logic (pmci-auto-accept.mjs)

```
FOR each proposed_link WHERE decision IS NULL AND category IN (PMCI_AUTO_ACCEPT_CATEGORIES):
  SKIP if confidence < PMCI_AUTO_ACCEPT_MIN_CONFIDENCE           → skip_reason: low_confidence
  SKIP if market_links has active row for provider_market_id_a   → skip_reason: already_linked_a
  SKIP if market_links has active row for provider_market_id_b   → skip_reason: already_linked_b
  SKIP if proposed_relationship_type != 'equivalent'             → skip_reason: non_equiv_type
  ACCEPT → POST /v1/review/decision { proposed_id, decision: "accepted" }
```

Confidence thresholds by category (informational — enforced by env var):
- `crypto`: guard-first asset-bucket prefilter gives initial confidence of `0.55`. Raise `PMCI_AUTO_ACCEPT_MIN_CONFIDENCE` once title-similarity scoring is added to the crypto proposer.
- `economics`: macro token overlap gives `0.50`. Same — raise threshold once semantic scoring improves.

> **Implication:** At default 0.70, auto-accept will skip most crypto/economics proposals today (they score 0.50–0.55). This is intentional — it means Phase E2 auto-accept is prep infrastructure; actual autonomous acceptance kicks in once proposer scoring is upgraded (see roadmap E2 next steps).

## Audit Schema (pmci-auto-accept-audit.mjs)

Queries accepted proposals from last 1 hour and checks:

```sql
SELECT pl.id, pl.category, pl.confidence, pl.proposed_relationship_type,
       a.status AS status_a, b.status AS status_b,
       a.category AS cat_a, b.category AS cat_b
FROM pmci.proposed_links pl
JOIN pmci.provider_markets a ON a.id = pl.provider_market_id_a
JOIN pmci.provider_markets b ON b.id = pl.provider_market_id_b
WHERE pl.decision = 'accepted'
  AND pl.created_at > now() - interval '1 hour'
```

Violation conditions (any → exit 1):
- `status_a` or `status_b` NOT IN `('active','open')`
- `proposed_relationship_type != 'equivalent'`
- `cat_a != cat_b` (cross-category link)

## API Contract

Uses existing endpoint — no new routes needed:

```
POST /v1/review/decision
Headers: x-pmci-api-key: <PMCI_API_KEY>
Body: { "proposed_id": <integer>, "decision": "accepted" }
Response 200: { "status": "accepted", "family_id": "...", "link_ids": [...] }
```

`proposed_id` must be cast to `Number()` (pg returns bigint as string).

## New Cron Jobs

```sql
-- pmci-review-crypto: fires 3h after ingest (ingest: :30 past 5,9,13,17,21,1 → review: 8,14,20,2)
SELECT cron.schedule('pmci-review-crypto', '0 8,14,20,2 * * *', $$
  SELECT net.http_post(
    url := current_setting('app.pmci_internal_trigger_url'),
    headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key')),
    body := '{"job":"review:crypto"}'::jsonb
  );
$$);

-- pmci-review-economics: fires 2.5h after ingest (ingest: :30 past 3,7,11,15,19,23 → review: 6,12,18,0)
SELECT cron.schedule('pmci-review-economics', '0 6,12,18,0 * * *', $$
  SELECT net.http_post(
    url := current_setting('app.pmci_internal_trigger_url'),
    headers := jsonb_build_object('x-pmci-api-key', current_setting('app.pmci_api_key')),
    body := '{"job":"review:economics"}'::jsonb
  );
$$);
```

## Architectural Decisions

**Why confidence threshold env var, not hardcoded?**
Crypto and economics proposers currently score 0.50–0.55 (asset-bucket prefilter only). Setting threshold at 0.70 means auto-accept is wired but dormant until proposer scoring improves — no risk of accepting low-quality links automatically. Operator lowers the threshold deliberately when they're confident in the proposer.

**Why audit as a separate script and not inline?**
Same pattern as sports/politics: guard logic and acceptance are separated so the audit can be re-run at any time independently. If an operator manually accepts proposals via `pmci:review`, the audit script still catches violations.

**Why not use an AI tool for review instead?**
An LLM reviewer (e.g. calling Claude API per proposal) would work but adds latency, cost, and a non-deterministic gate. The guard-first pattern (asset bucket + confidence floor + dedup) is cheaper, faster, and fully auditable. AI review is better suited to the *proposer scoring* step — improving title-similarity confidence before the gate — not the acceptance decision itself.

## Dependencies
- `pg` (existing) — guard queries
- `node fetch` (native, Node 18+) — POST to review API
- PMCI API server must be running when auto-accept script executes (PM2 handles this)
