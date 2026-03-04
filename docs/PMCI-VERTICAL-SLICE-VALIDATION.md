# PMCI Vertical Slice — Validation (VALIDATION_AGENT)

## Exact curl commands (DEM UUID first)

Assume API base `http://localhost:8787` (default PMCI port). DEM canonical event UUID: `c8515a58-c984-46fe-ac65-25e362e68333`.

```bash
# 1) Families for event
curl -s "http://localhost:8787/v1/market-families?event_id=c8515a58-c984-46fe-ac65-25e362e68333"

# 2) Pick first family id from response (e.g. .[0].id), then links
curl -s "http://localhost:8787/v1/market-links?family_id=1"

# 3) Divergence for same family
curl -s "http://localhost:8787/v1/signals/divergence?family_id=1"
```

Use the **first** `id` from step 1 in steps 2 and 3 (replace `1` if different).

## Expected non-empty fields

| Endpoint | Must have | Check |
|----------|-----------|--------|
| `GET /v1/market-families?event_id=<uuid>` | 200, JSON array | `length > 0`; each item has `id`, `label`, `canonical_event_id`, `num_links` (≥ 2). `consensus_price` may be null if no snapshots. |
| `GET /v1/market-links?family_id=<id>` | 200, JSON array | `length >= 2` (kalshi + polymarket). Each has `provider`, `provider_market_ref`, `relationship_type`, `confidence`. `price` and `divergence` non-null when both legs have snapshots. |
| `GET /v1/signals/divergence?family_id=<id>` | 200, JSON array | When both legs have `price_yes`: array length ≥ 1, each has `divergence`, `price`, `consensus_price`. Sorted by divergence desc. |

## Vertical Slice PASS checklist

- [ ] **API running** — `npm run api:pmci` (or `node src/api.mjs`); listening on 8787.
- [ ] **Families** — `GET /v1/market-families?event_id=c8515a58-c984-46fe-ac65-25e362e68333` returns array length > 0.
- [ ] **Links** — For first family `id`, `GET /v1/market-links?family_id=<id>` returns ≥ 2 items.
- [ ] **Divergence** — `GET /v1/signals/divergence?family_id=<id>` returns array (non-empty when both legs have prices).

## Failure diagnosis tree

| Symptom | Likely cause | Check |
|---------|--------------|--------|
| Families empty `[]` | Wrong event_id (not DEM UUID) or no families for event | Use UUID from `npm run seed:pmci` output (slug => uuid). Re-run seed if needed. |
| Links empty or length 1 | Family has no/one link in `v_market_links_current` | DB: `SELECT * FROM pmci.v_market_links_current WHERE family_id = <id>`. Re-seed. |
| Divergence empty `[]` | One or both legs missing recent snapshot or `price_yes` null | market-links response: check each leg has `price` and `consensus_price` non-null. If one leg null → that provider_market has no snapshot or snapshot.price_yes null (observer/ingestion). |
| consensus_price null on family | No snapshot with price_yes for any linked market | Same as above: ensure observer wrote snapshots for both providers. |
| 400 / validation error | event_id not UUID or family_id not positive int | Use exact UUID; family_id from families response `.id`. |

## One-liner (after starting API)

```bash
FAMILY_ID=$(curl -s "http://localhost:8787/v1/market-families?event_id=c8515a58-c984-46fe-ac65-25e362e68333" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d[0]?.id ?? '')")
curl -s "http://localhost:8787/v1/market-links?family_id=$FAMILY_ID"
curl -s "http://localhost:8787/v1/signals/divergence?family_id=$FAMILY_ID"
```
