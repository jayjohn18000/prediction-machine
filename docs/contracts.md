# Contracts: Core Data Objects

This document defines minimal contracts for three core data objects used in the prediction engine: `NormalizedOutcome`, `TopOfBook`, and `Opportunity`. These are pure data shapes with no execution logic.

## Conventions

- **Types**
  - `string`: UTF‑8 text
  - `number`: JSON number (no NaN/Infinity)
  - `DecimalString`: string decimal, e.g. `"1.23"` (avoid float rounding)
  - `ISO8601`: UTC timestamp string with timezone, e.g. `"2026-02-24T12:34:56Z"`
- **IDs**
  - All IDs are opaque `string`s, unique within their namespace.
- **Nullability**
  - Fields listed as required must be present; their values may be `null` only if explicitly allowed in the constraint notes.

---

## NormalizedOutcome

**Role**: Canonical description of a tradable outcome, normalized across venues and raw feeds.

- **Owned by**: Data normalization / domain layer.

**Required fields**

- `id: string`
  - Stable, unique identifier for the normalized outcome.
  - Constraint: globally unique; never reused.
- `eventId: string`
  - Identifier for the underlying event (e.g. game, election).
  - Constraint: refers to a separately defined event object.
- `venue: string`
  - Source venue/exchange code (e.g. `"exchange_a"`).
- `sourceMarketId: string`
  - Raw market identifier in the source venue.
- `label: string`
  - Human‑readable label for the outcome (e.g. `"Team A wins"`).
- `side: "YES" | "NO" | "OVER" | "UNDER" | "OTHER"`
  - Normalized directional side relative to the event definition.
- `settlementCurrency: string`
  - ISO 4217 currency code (e.g. `"USD"`).
- `payoutPerUnit: DecimalString`
  - Gross payout per unit at full settlement (e.g. `"1.00"` for $1 per share).
- `status: "OPEN" | "SUSPENDED" | "SETTLED" | "CANCELLED"`
  - Constraint: transitions are monotonic toward terminal states; terminal states are `SETTLED` or `CANCELLED`.
- `createdAt: ISO8601`
- `updatedAt: ISO8601`

**Key constraints**

- `id` is the primary key and is the join key for `TopOfBook` and `Opportunity`.
- `venue + sourceMarketId` pair must be unique for active outcomes.

---

## TopOfBook

**Role**: Snapshot of the best bid/ask for a single `NormalizedOutcome` on a given venue.

- **Owned by**: Market data / feed handler layer.

**Required fields**

- `normalizedOutcomeId: string`
  - Constraint: must match an existing `NormalizedOutcome.id`.
- `venue: string`
  - Constraint: must equal the `venue` of the referenced `NormalizedOutcome`.
- `timestamp: ISO8601`
  - Time the snapshot was observed.
- `bidPrice: DecimalString | null`
  - Best bid price; `null` if no bid exists.
- `bidSize: DecimalString | null`
  - Aggregate size at best bid; `null` iff `bidPrice` is `null`.
- `askPrice: DecimalString | null`
  - Best ask price; `null` if no ask exists.
- `askSize: DecimalString | null`
  - Aggregate size at best ask; `null` iff `askPrice` is `null`.

**Key constraints**

- If both `bidPrice` and `askPrice` are non‑null, then `bidPrice <= askPrice`.
- All monetary values are quoted in the `settlementCurrency` of the referenced `NormalizedOutcome`.
- Each `(normalizedOutcomeId, venue)` pair may have many snapshots over time but at most one active snapshot per timestamp in a given stream.

---

## Opportunity

**Role**: Purely informational description of a pricing discrepancy or edge derived from `TopOfBook` and `NormalizedOutcome` data. This object does not encode how to act on the opportunity.

- **Owned by**: Analytics / opportunity detection layer.

**Required fields**

- `id: string`
  - Unique identifier for this opportunity instance.
- `normalizedOutcomeId: string`
  - Constraint: must match an existing `NormalizedOutcome.id`.
- `createdAt: ISO8601`
  - Time at which the opportunity was detected.
- `expiresAt: ISO8601`
  - Recommended expiry; after this time the opportunity should be treated as stale.
- `type: "CROSS_VENUE" | "CROSS_SIDE" | "OUTRIGHT_MISPRICE"`
  - High‑level classification of the opportunity.
- `legs: Array<{
    venue: string;
    side: "BUY" | "SELL";
    price: DecimalString;
    size: DecimalString;
  }>`
  - Minimal set of price/size points that define the edge.
- `edgePct: number`
  - Estimated gross edge as a percentage (e.g. `0.02` for 2%).

**Key constraints**

- `legs` must contain at least one entry and all `venue` values must correspond to known venues.
- All `legs` refer to the same `normalizedOutcomeId`.
- `edgePct` must be strictly positive; zero or negative values are not considered opportunities.
- Consumers may choose to ignore or act on an `Opportunity`, but any execution behavior lives in separate layers and is out of scope of this contract.

