# Cursor Prompt: Crypto Proposer — Ladder Market Grouping

## What to build

Rewrite `scripts/review/pmci-propose-links-crypto.mjs` so it groups markets by event before proposing links. The current version cross-joins every Kalshi crypto market against every Polymarket crypto market individually. The new version should:

1. **Group provider_markets by event_ref.** Kalshi markets sharing the same `event_ref` (e.g., all 28 strikes under `KXBTCY-27JAN0100`) are one event group. Polymarket markets sharing the same `event_ref` (slug) are one event group.

2. **Match event groups across venues.** For each Kalshi event group, find the best-matching Polymarket event group using: same `cryptoAssetBucket` (from `lib/matching/compatibility.mjs`) AND title similarity on the event-level question (not individual strike titles). Example: Kalshi `KXBTCY-27JAN0100` ("Bitcoin price at the end of 2026") should match Polymarket `bitcoin-btc-price-end-of-2026` or similar.

3. **For each matched event pair, propose links at two levels:**
   - **Event-level proposal:** One proposal linking the two event groups as `equivalent`. This is the baseline — it always gets created if the events match. Set confidence based on title similarity of the event-level question (not strikes). Use `proposal_type: "event_group"` in the reasons JSON.
   - **Strike-to-strike proposals:** For each Kalshi strike market in the group, look for a Polymarket market in the matched group with a matching strike value (parse the dollar threshold from the title, e.g., "$100,000" or "$100K"). If found within a tolerance of ±1%, propose that specific pair with higher confidence (0.75+). Use `proposal_type: "strike_match"` in the reasons JSON. Include `strike_value_k` and `strike_value_p` in the features JSON.

4. **Family creation on acceptance.** The first accepted proposal for an event group creates a new family. Subsequent strike-match acceptances for the same event should use `proposal_type: "attach_to_family"` with `target_family_id` pointing to the existing family. The review-service already handles this — see `src/services/review-service.mjs` line ~95 for the `attach_to_family` path.

## Key files to read first

- `scripts/review/pmci-propose-links-crypto.mjs` — current proposer (replace the cross-join logic)
- `lib/matching/compatibility.mjs` — `cryptoAssetBucket()` and `cryptoPairPrefilter()` 
- `lib/ingestion/crypto-universe.mjs` — how `event_ref` and `metadata.series_ticker` are populated
- `src/services/review-service.mjs` — how acceptance creates families and the `attach_to_family` path
- `docs/db-schema-reference.md` — column names, type gotchas

## Schema context

`provider_markets` already has:
- `event_ref` (text) — Kalshi event ticker or Polymarket slug. This is the grouping key.
- `metadata` (jsonb) — contains `series_ticker` for Kalshi (e.g., `KXBTC`), `market_id` and `outcome_name` for Polymarket
- `provider_market_ref` (text) — Kalshi ticker string or Polymarket `slug#OutcomeName`

`proposed_links` stores:
- `reasons` (jsonb) — put `proposal_type`, `event_ref_k`, `event_ref_p`, `target_family_id` here
- `features` (jsonb) — put `strike_value_k`, `strike_value_p`, `event_title_k`, `event_title_p` here

## Strike value parsing

Write a `parseStrikeValue(title)` helper that extracts dollar thresholds from titles like:
- "BTC price on Jan 1, 2027?" with ticker `KXBTCY-27JAN0100-T74999.99` → parse from ticker: 74999.99
- "Will Bitcoin be above $100000 by June 1, 2026" → 100000
- "What will Bitcoin hit in April 2026?: ↑ $150" → 150 (but note this is shorthand for $150K on Polymarket)

For Kalshi, the strike value is most reliably parsed from the ticker suffix after `-T` (e.g., `KXBTCY-27JAN0100-T74999.99` → 74999.99).
For Polymarket, parse from the title — look for `$` followed by digits, or `↑`/`↓` followed by `$` and digits.

Match strikes across venues when `abs(strike_k - strike_p) / max(strike_k, strike_p) < 0.01` (within 1%).

## What NOT to change

- Do not modify the ingestion scripts
- Do not modify the review-service or acceptance flow
- Do not modify the families or market_links tables
- Keep the existing `--dry-run`, `--verbose`, `--limit`, `--market-cap` CLI flags
- Keep the existing dedup check against `proposed_links`

## Invariants

- No .env writes
- Run `npm run verify:schema` after if any migration is needed (none should be)
- Active markets only — the `WHERE status IN ('active','open')` filter stays

## Test it

After building, run:
```bash
node scripts/review/pmci-propose-links-crypto.mjs --dry-run --verbose
```

Expected output should show event groups found, cross-venue event matches, and both event-level and strike-level proposal counts. The `considered` count should be much lower than the old cross-join (hundreds, not tens of thousands) because we're matching events first, then strikes within matched events.

Then run live:
```bash
npm run pmci:propose:crypto
```

Then check what was proposed:
```bash
npm run pmci:smoke
```
