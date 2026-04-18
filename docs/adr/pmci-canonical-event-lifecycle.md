# ADR: Canonical event lifecycle (settled games / macro events)

## Status
Proposed — trigger when resolved noise affects proposals or observer cost.

## Context
When upstream markets settle or close, PMCI still holds `canonical_events`, families, and links. Choices: **archive** (soft), **delete**, or **mark resolved** with filters in proposers and UIs.

## Decision (to confirm)
Pick one primary lifecycle plus retention rules for snapshots and links.

## Consequences
Affects ingestion filters, proposal queues, and housekeeping crons.
