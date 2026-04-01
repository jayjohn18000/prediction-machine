# Phase E1.4 — Polymarket Sports Fix Schema & Architecture

## Data Models

No migrations required. All fixes are in the ingestion layer.

### Target state after E1.4

```sql
-- pmci.provider_markets — Polymarket sports rows should exist:
SELECT provider_id, category, sport, COUNT(*), MAX(last_seen_at)
FROM pmci.provider_markets
WHERE provider_id = 2 AND category = 'sports'
GROUP BY 1, 2, 3;
-- Expected: rows for nba, nfl, mlb, nhl, soccer, etc.

-- Status should be 'active' (not 'open' or 'closed')
SELECT status, COUNT(*) FROM pmci.provider_markets
WHERE provider_id = 2 AND category = 'sports' GROUP BY 1;
-- Expected: {"status":"active", "count": N}
```

---

## Polymarket Gamma API Reference (verified 2026-04-01)

### Correct endpoints

| Endpoint | Purpose | Valid params |
|---|---|---|
| `GET /sports` | Authoritative sport→tag_id mapping | none required |
| `GET /tags?limit=500&offset=N` | All tags (fallback) | limit, offset |
| `GET /markets?tag_id=X&closed=false&archived=false&limit=100&offset=N` | Markets for a tag | tag_id, closed, archived, limit, offset, order, ascending |

### INVALID parameters (do NOT use)
- `active=true` — not a valid Gamma API parameter; causes empty responses

### Market object schema (Gamma API)
```json
{
  "id": "string",
  "conditionId": "0x...",
  "question": "Will the Lakers beat the Celtics?",
  "slug": "will-lakers-beat-celtics-2026-04-10",
  "outcomes": ["Yes", "No"],
  "outcomePrices": "[\"0.55\",\"0.45\"]",    // STRINGIFIED JSON — parse with JSON.parse()
  "clobTokenIds": "[\"12345\",\"67890\"]",   // STRINGIFIED JSON — parse with JSON.parse()
  "category": "sports",
  "startDate": "2026-04-10T18:00:00Z",
  "endDate": "2026-04-11T04:00:00Z",
  "active": true,
  "closed": false,
  "archived": false,
  "volume": "125000.00",
  "liquidity": "45000.00",
  "tags": [{"id": "100381", "slug": "nba"}]
}
```

### /sports endpoint response shape
```json
[
  {
    "id": "nba",         // or sport_id / slug — field name may vary
    "tags": "100381,100382,100383",   // COMMA-SEPARATED string of tag IDs
    "image_url": "...",
    "resolution_source_url": "..."
  }
]
```

---

## Architectural Decisions

### Why `/sports` endpoint first, keyword fallback second

The `/sports` endpoint is authoritative and fast — one request returns all sports tag IDs. Keyword filtering across all tags requires paginating thousands of tags (7,000+) to find ~30–50 sports tags. The `/sports` endpoint reduces discovery from ~14 API calls to 1. The fallback preserves resilience if Polymarket removes or changes `/sports`.

### Why `status = 'active'` not `'open'`

Kalshi uses `'active'` for live markets. Polymarket's `active: true` maps to the same concept. Using `'open'` for Polymarket but `'active'` for Kalshi creates an inconsistency that breaks queries like `WHERE status = 'active'` which currently return 0 Polymarket rows. Standardizing on `'active'` = live market across both providers makes the schema consistent.

### Why `closed=false&archived=false` instead of just `closed=false`

`closed=false` filters resolved markets. `archived=false` filters markets Polymarket has hidden (often expired but unresolved or low-liquidity markets). Using both together most closely matches "live tradeable markets" — which is the correct analogue for Kalshi's `status='active'` filter.

### Rate limits

- Polymarket Gamma API: ~15,000 requests per 10 seconds
- Current sleep: 300ms between tag pages, 500ms between tags
- These sleeps are conservative enough; no changes needed for rate limiting

---

## Dependencies

No new dependencies. Uses existing `fetch` (Node 18+ built-in) and `pg` client.

---

## Environment Variables

No new env vars needed.

---

## E1.5 Preview — Sports Proposer

Once E1.4 is complete and Polymarket sports data accumulates (target: 3–7 days of 4-hour ingest cycles), E1.5 will:

1. Add `category` parameter to `lib/matching/proposal-engine.mjs` (currently hardcoded `'politics'`)
2. Create sport-specific entity extractors (team names, league codes, game dates) analogous to the politics candidate-name extractors
3. Add `game_date` proximity scoring to the pair-scoring function — game-level markets must be within ±1 day to be considered equivalent
4. Run sports proposer dry-run: `node lib/matching/proposal-engine.mjs --category=sports --dry-run`
