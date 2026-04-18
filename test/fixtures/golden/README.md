# Golden fixtures (cross-venue regression)

Place **one cross-venue event per category** (politics, sports, economics, crypto) as:

- `provider-native/` — raw Kalshi / Polymarket JSON snippets from the APIs
- `normalized/` — expected `provider_markets`-shaped rows (or SQL excerpts) after ingestion rules

Use these when changing decomposition, `event_ref`, or metadata contracts. The coverage benchmark (`npm run pmci:benchmark:coverage`) can help capture candidate events before freezing them here.
