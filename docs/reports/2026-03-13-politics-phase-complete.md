# Politics Phase Closeout — 2026-03-13

## Executive Summary
Politics remediation is complete under the agreed **semantic-correctness-first** standard.

- Active link rows: **176 → 139**
- Cross-provider families: **72 → 60**
- Legacy semantic cleanup: **12 families**, **37 rows** deactivated (`status='removed'`)
- Residual semantic violations (gov/pres ruleset): **0**

## Remediation SQL Outcome (Applied)
Cleanup scope: **governor + president active cross-provider families only**.

Semantic invalidation rules applied:
1. `party` ↔ `binary_yesno`
2. `primary_or_nominee` ↔ `general_or_winner`
3. `runoff` ↔ `general_or_winner`

Action performed:
- Updated `pmci.market_links.status` from `active` → `removed` for affected families.
- Added remediation provenance in `reasons` JSON:
  - `remediation: politics_semantic_cleanup_2026-03-13`
  - `reason: legacy_semantic_mismatch`
  - `rule_set: [party_vs_binary_yesno, primary_or_nominee_vs_general_or_winner, runoff_vs_general_or_winner]`

## Final Metrics (Post-remediation)

| Topic | Kalshi link rate |
|---|---:|
| Governor | **0.067** |
| President | **0.636** |
| Senate | **0.542** |

Source: latest probe/audit run on 2026-03-13.

## Integrity Checks
- Strict audit packet generated successfully.
- Semantic residual check (gov/pres invalid-family detector): **0**.

## D6 Coverage Note
Governor remains below the D6 threshold target (`0.067 < 0.20`).

Per closeout policy for this phase, this is **acceptable** because:
- No active semantic mismatches remain.
- Guard layer prevents recurrence of known invalid link classes.
- Remaining gap is a **coverage/business threshold** item, not a semantic integrity failure.

## Sign-off
**POLITICS PHASE COMPLETE** for semantic remediation and integrity closeout.
