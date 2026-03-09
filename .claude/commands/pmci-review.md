Run an interactive PMCI proposal review session for prediction-machine.

Working directory: /Users/jaylenjohnson/prediction-machine

## Pre-pass (PROPOSAL_REVIEWER triage)
Before entering interactive review, run the PROPOSAL_REVIEWER triage logic from `agents/PROPOSAL_REVIEWER.md`:

1. Query pending count: `SELECT count(*) FROM pmci.proposed_links WHERE decision IS NULL`
2. If pending > 5, run bulk-reject patterns in order:
   - Pattern A: Cross-geography fan-out — same Kalshi market paired 3+ times against different-state Polymarket markets
   - Pattern B: Placeholder candidates — either title contains `Candidate [A-Z]`, `Player \d+`, `Person \d+`, `Option \d+`
   - Pattern C: Inverted outcome — `#No` ref paired with a Democrat question (or vice versa)
   - Pattern D: Cross-country — US market paired with non-US market (Toronto, Canada, UK, etc.)
   For each pattern: run the SQL from `agents/PROPOSAL_REVIEWER.md`, print count of rows rejected.
3. After bulk-reject, check if any remaining proposals have confidence ≥ 0.95 and pass all auto-accept gates (no placeholders, geography aligned, years match if present). Present these for quick human confirm before accepting.
4. Print a triage summary: `[N bulk-rejected] | [N auto-accepted] | [N for manual review]`

## Interactive review
Steps:
1. Run `npm run pmci:review` (no flags) to fetch and display the next pending proposal from the API
2. If the output says "No pending proposals" — print that and stop
3. If a proposal is returned, format it as a readable card:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Proposal [ID]   Type: [equivalent|proxy]   Confidence: [0.XX]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Market A ([provider])
  Ref:   [provider_market_ref]
  Title: [title]
  Price: [price_yes]   Observed: [observed_at]

Market B ([provider])
  Ref:   [provider_market_ref]
  Title: [title]
  Price: [price_yes]   Observed: [observed_at]

Reasons:
  title_similarity: [val]   entity_match: [val]   slug_similarity: [val]
  time_delta_hours: [val]   structure_hint: [val]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

4. Use AskUserQuestion to ask: "Decision for this proposal?" with options: Accept, Reject, Skip
5. Run the corresponding command:
   - Accept → `npm run pmci:review -- --accept`
   - Reject → `npm run pmci:review -- --reject`
   - Skip   → `npm run pmci:review -- --skip`
6. Print the API response (decision submitted)
7. Ask: "Review another proposal?" — if yes, loop back to step 1; if no, stop

Note: The review CLI fetches the current top proposal each time it's run. Each invocation is independent.
