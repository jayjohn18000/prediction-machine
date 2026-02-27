# Schema (Operational)

## Core Expectations
- Required PMCI tables and columns verified by `npm run verify:schema`
- View `pmci.v_market_links_current` must exist
- Canonical market family linkage required for cross-provider comparisons

## Validation Commands
- `npm run verify:schema`
- `npm run pmci:smoke`
- `npm run pmci:check-coverage`
- `npm run pmci:check-top-divergences`

## Compatibility Policy
- Backward-compatible schema changes by default
- Destructive migrations require explicit operator approval
