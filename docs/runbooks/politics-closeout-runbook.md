# Politics Closeout Runbook (Reusable)

## Purpose
Deterministic closeout flow for a category normalization phase (politics now; reusable for sports/crypto).

## Preconditions
- PMCI API env configured
- DB reachable
- Category-specific proposer/guard logic enabled

## Command Chain (closeout)
1) Refresh category discovery/config inputs (if applicable)
2) Run targeted remediation (only if residual invalid classes exist)
3) Run strict gate bundle:
   - `npm run pmci:audit:packet -- --strict`
   - `npm run pmci:probe`
   - semantic residual query (must return 0)

## Required Gates
- Residual semantic violations = 0
- Strict audit packet exits clean
- Probe indicates service/data readiness
- No new invalid classes introduced by proposer

## Evidence Artifacts
- `docs/reports/latest-politics-audit-packet.json`
- Category closeout report in `docs/reports/`
- Roadmap status update with phase state + carryover backlog

## Sign-off Template
- Phase: <name>
- Status: PHASE COMPLETE
- Residual invalid classes: <n>
- Non-blocking carryover: <list>
- Next phase entry: APPROVED / BLOCKED

## Rollback Notes
- If remediation over-prunes, restore affected rows from backup/snapshot and rerun strict gate bundle.
- Never merge closeout docs unless strict gates pass on latest run.
