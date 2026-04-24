# Agent A3 — Resolution-Equivalence Audit

_Read `docs/pivot/north-star.md` and `docs/pivot/dependency-map.md` before starting. You run fully in parallel with A1, A2, A4. You are not writing code — you are writing the quality gate that prevents the backtest from lying._

## Why this work matters

A "match" between Kalshi and Polymarket is not a match unless both markets resolve on the same underlying event and criteria. If Kalshi resolves on "AP call at 11:59 ET" and Polymarket resolves on "official league final score recorded by Sportradar," those are two different markets on the same game. The spread between them is not arb — it's a bet on which resolution source is faster or more lenient. When they disagree (rare but real), both sides of a "hedged" trade can lose.

Families with non-equivalent resolution poison the backtest. They look tradeable on-paper, produce apparent edge, and then realize losses on the disagreement tail. Every one of those families included in the backtest biases the output toward a false GREEN.

Your job is to make sure the backtest only sees families where resolution equivalence is real.

## What success looks like

- A CSV (or equivalent structured artifact) covering every currently-linked sports family — roughly 108 rows as of 2026-04-19, but pull the live number.
- Each row contains: `family_id`, `sport`, `event_type`, `kalshi_market_id`, `poly_market_id`, `kalshi_resolution_rules` (the text), `poly_resolution_rules` (the text), `resolution_source_kalshi` (e.g., AP, NBA.com, official league), `resolution_source_poly`, `timing_alignment` (do both settle at the same event-state trigger?), and a classification: `equivalent` / `non_equivalent` / `ambiguous`.
- Each non-equivalent and ambiguous classification has a one-sentence human reason.
- The artifact is consumable as a filter input by the backtest engine (A5) — a simple join on `family_id` with a WHERE on classification.

## The three-way classification

- **`equivalent`** — both sides resolve on the same underlying event outcome, with resolution source + timing such that a reasonable trader would expect both to settle the same way in all but ~1% of cases. These are the only families that count in the backtest's headline ranked table.
- **`non_equivalent`** — the resolution criteria differ meaningfully. Could be resolution source (AP vs. Sportradar), criterion (final score vs. score after regulation), or timing (when overtime counts). These families are excluded entirely from the backtest's ranked output.
- **`ambiguous`** — the rules text is unclear, or one side's rules are missing, or you genuinely cannot tell. These families are reported separately and the backtest does not count them toward the decision either way. Ambiguous is a valid answer — do not force a call.

## Why a human-readable text column matters

The CSV is not a one-time filter. It is the document the owner reads to understand *why* a family was excluded. "Non-equivalent because Kalshi resolves on regulation-time score and Polymarket resolves on final including overtime" is a defensible exclusion. "Non-equivalent because I said so" is not. Every non-equivalent classification must be explainable to the owner in one sentence.

## Scope boundaries

**In scope:**
- Reading both sides' `resolution_rules` text from `provider_markets` (or the provider APIs where DB text is truncated).
- Classifying each of the ~108 sports families.
- Producing the CSV.
- Flagging systemic patterns (e.g., "all NBA markets have a resolution timing mismatch" — that's a finding).

**Out of scope:**
- Fixing ingestion of resolution rules text (if it's missing, flag; don't rebuild the ingestion path).
- Building an automated equivalence classifier. v1 is a manual or LLM-assisted audit. Automation is a follow-on only if the pivot expands coverage.
- Extending the audit to non-sports categories.
- Re-classifying families whose links are already inactive.

## What "done" requires you to prove

1. The CSV has a row for every family in `v_market_links_current` whose `category='sports'` (or equivalent).
2. Every classification has a reason the owner can read and agree or disagree with.
3. Families classified as `equivalent` can be joined against by A5 with a single SQL filter.
4. A brief summary report states: total families audited, count in each bucket, and any systemic patterns worth the owner's attention.

## Subagent split (suggested)

Parallelize by sport: one subagent per sport (NBA, MLB, tennis, soccer, boxing, NCAAB, etc.). Each subagent reads the rules for every family in its sport and classifies. Results converge into one CSV. Output schema is shared across subagents and documented before they start so merges are clean.

## Things to escalate

- If a sport has zero `equivalent` families (systemic resolution-source divergence across that sport), flag immediately. That's a finding that changes sequencing.
- If resolution rules text is not stored in the DB for a significant subset of families, flag — fetching from the provider API may be needed.
- If a family's two markets appear to be on *different underlying events* entirely (a linking error, not a resolution error), flag — that's feedback to the linker, not an audit classification.

## What not to do

- Do not classify borderline cases as `equivalent` to keep the numerator high. Ambiguous is a valid answer.
- Do not judge equivalence by market title similarity. Rules text is the ground truth.
- Do not rewrite any upstream linking code based on what you find. Report findings; don't silently fix.
