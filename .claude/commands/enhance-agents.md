You are running the AGENT_ENHANCER skill for prediction-machine.

Usage: `/enhance-agents [TARGET_AGENT]`
Optional flag: `--list-only` (print proposals without applying)

Working directory: /Users/jaylenjohnson/prediction-machine

## Step 1 — Parse arguments
Parse `$ARGUMENTS`:
- Extract target agent name if present (e.g. "PROPOSAL_REVIEWER")
- Check for `--list-only` flag
- If no agent name: scan all agents with `## Enhancement signals` sections

## Step 2 — Read AGENT_ENHANCER definition
Read `agents/AGENT_ENHANCER.md` in full to load the 3-phase execution logic.

## Step 3 — Phase A: Read the target agent
- If target specified: read `agents/$TARGET_AGENT.md`
- If no target: glob `agents/*.md`, read each, check for `## Enhancement signals` section
- Extract Enhancement signals config from any found sections

## Step 4 — Phase B: Mine the data trail
For each agent with Enhancement signals, run the declared queries:

```js
import { query } from './src/db.mjs';
```

For PROPOSAL_REVIEWER, run:
```js
// Query 1: Outcome inversion candidates
const q1 = await query(`
  SELECT pl.id, ma.title, mb.title, pl.confidence, pl.reviewer_note
  FROM pmci.proposed_links pl
  JOIN pmci.provider_markets ma ON ma.id = pl.provider_market_id_a
  JOIN pmci.provider_markets mb ON mb.id = pl.provider_market_id_b
  WHERE pl.decision = 'rejected'
    AND pl.features IS NOT NULL
    AND (pl.features->>'outcome_name_match')::numeric = 0
  LIMIT 10
`);

// Query 2: Extreme date delta candidates
const q2 = await query(`
  SELECT pl.id, ma.title, mb.title,
         (pl.features->>'date_delta_days')::int AS delta_days, pl.reviewer_note
  FROM pmci.proposed_links pl
  JOIN pmci.provider_markets ma ON ma.id = pl.provider_market_id_a
  JOIN pmci.provider_markets mb ON mb.id = pl.provider_market_id_b
  WHERE pl.decision = 'rejected'
    AND pl.features IS NOT NULL
    AND (pl.features->>'date_delta_days')::int > 120
  LIMIT 10
`);

// Query 3: Recurring manual rejection notes
const q3 = await query(`
  SELECT reviewer_note, count(*) as n
  FROM pmci.proposed_links
  WHERE decision = 'rejected'
    AND reviewer_note NOT LIKE 'bulk-reject:%'
    AND reviewer_note IS NOT NULL
  GROUP BY reviewer_note
  HAVING count(*) >= 2
  ORDER BY n DESC
`);

// Query 4: Fan-out calibration
const q4 = await query(`
  SELECT provider_market_id_a, count(*) as n
  FROM pmci.proposed_links
  WHERE decision = 'rejected'
  GROUP BY provider_market_id_a
  HAVING count(*) > 2
  ORDER BY n DESC
  LIMIT 10
`);
```

## Step 5 — Phase C: Generic structural analysis
1. Read `agents/` directory listing
2. Read `.claude/commands/coordinate.md` routing table
3. Diff: any agent file not in routing table → routing gap proposal
4. Scan target agent for hardcoded numerics; compare to Phase B evidence
5. Check cross-references in Scope section for broken agent links
6. Check proposed patterns don't duplicate existing content

## Step 6 — Print numbered proposals
Format each using the Enhancement Proposal block from `agents/AGENT_ENHANCER.md`.
Print a numbered summary at the end.

If `--list-only` flag: stop here.

## Step 7 — Apply approved proposals
Ask: "Apply all, specific numbers, or none?"
- For each approved: use Edit tool for surgical changes to `agents/` or `.claude/commands/` files
- Never modify `src/`, `scripts/`, migrations

## Step 8 — Verify
```bash
npm run pmci:smoke
```

## Step 9 — Record
Append to `docs/decision-log.md`:
```
### [date] — AGENT_ENHANCER run
Target: [agent name]
Proposals generated: [N]
Proposals applied: [N]
Changes: [one-line summary per applied proposal]
```

## Scope guard
Only modifies: `agents/`, `.claude/commands/`, `docs/decision-log.md`
Never touches: `src/`, `scripts/`, `supabase/`, `~/.claude/`
