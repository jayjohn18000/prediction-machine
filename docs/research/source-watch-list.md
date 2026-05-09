---
title: PMCI Source Watch List — Structural-Change Tracking
tags: [research, sources, watch-list, v1]
status: current
last-verified: 2026-05-08
sources:
  - "[[scanner-handoff-brief-2026-05-06]]"
  - "[[scanner-plan-v1]]"
---

# Source Watch List

**Created:** 2026-05-08
**Purpose:** track structural changes in Kalshi/Polymarket and the prediction-market space that could create new edges OR kill existing ones
**Cadence:** weekly review (Sunday morning, 30 min)

---

## §1 Purpose

The scanner detects edges that already exist. This watch list is the *upstream* signal — it surfaces structural shifts that could:

1. Create new edges (new contract types, fee changes, market-maker entries/exits)
2. Kill existing edges (sophistication grows, syndicates enter, dynamic fees deployed)
3. Change the rules of the game (Kalshi ToS changes, regulatory shifts)

These are the leading indicators. Most retail traders find out about them weeks late. Watching them gives PMCI a 30–90 day head start on most structural changes.

The watch list integrates into the weekly review ritual (`hypothesis-tracker-template.md` §7). Each Sunday, operator scans Tier 1 sources, then Tier 2, then optionally Tier 3.

---

## §2 Tier 1 — Highest leverage (mandatory weekly)

These are the highest-value free signals. Ten-minute weekly check on each.

### 2.1 CFTC filings (KalshiEx)

**URL:** https://www.cftc.gov (search "KalshiEx" in filings database)
**What it tells you:** New contract type approvals are filed 30–90 days before launch. Filings name the contract structure, settlement criteria, fees. This is the most authoritative leading indicator of new market types.
**Cadence:** weekly diff via Wayback Machine or Visualping
**Action on signal:** if a new contract type is approved with novel settlement criteria, draft a hypothesis (likely `resolution_rule` type) before the contract is live. First-mover advantage.

### 2.2 Kalshi help docs

**URL:** https://help.kalshi.com
**What it tells you:** market rule changes, fee schedule changes, withdrawal/deposit changes
**Cadence:** weekly diff via Wayback Machine snapshot or Visualping
**Action on signal:** any fee schedule change recalibrates every Whelan-band edge calculation. Apply Whelan SQL replication immediately to test if 50–80c band still nets positive after fees.

### 2.3 Kalshi API docs

**URL:** https://docs.kalshi.com
**What it tells you:** endpoint changes, rate-limit shifts, new WS message types, deprecated paths
**Cadence:** weekly
**Action on signal:** any rate-limit change affects the NBA detector's poll cadence; verify cdn.nba.com and Kalshi REST are still inside limits.

### 2.4 4AM Club Substack

**URL:** https://4amclub.substack.com
**What it tells you:** practitioner analysis from Aaron Miller (independent Kalshi trader). Highest-quality public discussion of Kalshi-specific edges.
**Cadence:** subscribe to RSS / email
**Action on signal:** any post about a new edge or strategy → cross-reference with PMCI hypothesis tracker. If we already have it as a hypothesis, treat as confirmation. If it's new, draft a hypothesis the same day.

---

## §3 Tier 2 — High value (weekly skim)

Five-minute weekly check on each.

### 3.1 LinkedIn job postings (Kalshi, Polymarket)

**URL:** https://www.linkedin.com/jobs/search → search "Kalshi" or "Polymarket"
**What it tells you:** hiring patterns reveal product roadmap 3–12 months ahead. ML hires → expect tighter spreads. Quant trader hires → expect more institutional flow. Compliance hires → expect rule changes.
**Cadence:** weekly search
**Action on signal:** clusters of similar hires in one quarter → write an `analytical` or `behavioral` hypothesis anticipating the change.

### 3.2 Polymarket blog

**URL:** https://news.polymarket.com
**What it tells you:** strategy patches, fee changes, new market types. Polymarket often leads Kalshi on innovation; Kalshi follows in 6–12 months.
**Cadence:** RSS subscribe
**Action on signal:** Polymarket changes that map onto Kalshi → draft a hypothesis predicting the same change is coming to Kalshi.

### 3.3 r/Kalshi

**URL:** https://reddit.com/r/Kalshi
**What it tells you:** community patch discussion. First place users notice new MMs entering, fee changes affecting edge.
**Cadence:** daily lurk, sort by new (Sunday catch-up)
**Action on signal:** repeated complaints about a specific market type or fee → likely real structural change happening.

### 3.4 Kalshi / Polymarket Twitter

**URL:** follow @Kalshi, @Polymarket
**What it tells you:** real-time announcements (some product launches go to Twitter before docs)
**Cadence:** daily passive
**Action on signal:** product launch tweets → check API docs and help docs same day for the technical detail.

### 3.5 Polymarket Discord

**URL:** Polymarket public Discord (link from polymarket.com)
**What it tells you:** real-time chatter from active Polymarket traders. Often surfaces new edges first.
**Cadence:** weekly lurk in #strategy / #general
**Action on signal:** any sustained discussion of a specific edge or pattern → cross-reference for Kalshi applicability.

---

## §4 Tier 3 — Optional (monthly or as-needed)

Skim only if Tier 1 and 2 produce nothing of interest in a given week.

### 4.1 GitHub mentions

**URL:** GitHub search for "kalshi" or "polymarket" filtered to last 30 days
**What it tells you:** open-source bot updates, new SDK releases, community drift
**Cadence:** monthly
**Action on signal:** new tool → evaluate for inclusion in scanner ingestion or MM bot.

### 4.2 Bloomberg / WSJ prediction-market coverage

**URL:** Bloomberg, WSJ search for "prediction market" or "Kalshi"
**What it tells you:** institutional sentiment, regulatory mood
**Cadence:** monthly
**Action on signal:** mainstream coverage of "retail traders losing money" or "bots dominating" → adjust expectations on edge persistence.

### 4.3 Academic literature

**URL:** SSRN search for "Kalshi" or "prediction market"
**What it tells you:** quantitative analyses of biases, edges, market structure
**Cadence:** monthly
**Action on signal:** Whelan-style replication studies on new contract types → operationalize as new structural hypothesis.

---

## §5 Weekly review checklist

Sunday morning, 30 minutes total:

1. **Tier 1 — 4 sources × ~5 min each = 20 min**
   - [ ] CFTC filings: any new Kalshi filings since last week?
   - [ ] Kalshi help docs: any diff vs last week's snapshot?
   - [ ] Kalshi API docs: any diff?
   - [ ] 4AM Club: any new posts?

2. **Tier 2 — 5 sources × ~2 min each = 10 min**
   - [ ] LinkedIn jobs: hiring pattern clusters?
   - [ ] Polymarket blog: any posts?
   - [ ] r/Kalshi top week: any pattern complaints?
   - [ ] Twitter: any product announcements?
   - [ ] Polymarket Discord: any sustained edge discussion?

3. **Action capture**
   - [ ] For any signal flagged: write a one-line hypothesis sketch in `~/prediction-machine/docs/strategies/inbox/YYYY-MM-DD.md`
   - [ ] If signal kills an existing hypothesis: tag the hypothesis with `last_validated_at = today` (track when it was last confirmed alive) AND verify in next weekly review

Total: 30 min/week.

---

## §6 Subscription instructions

Set up these once, then the watch list runs itself:

| Source | Subscription method |
|---|---|
| CFTC filings | Wayback Machine bookmark + Visualping (free tier, 1 page) |
| Kalshi help docs | Visualping or Sitemap RSS |
| Kalshi API docs | GitHub repo watch (if open-sourced) or Visualping |
| 4AM Club | Substack email subscription (free) |
| LinkedIn | LinkedIn search alert (free; weekly digest email) |
| Polymarket blog | RSS reader (Feedly free tier) |
| r/Kalshi | Reddit RSS feed: `https://reddit.com/r/Kalshi/.rss` |
| Twitter | Twitter list: pm-watching |
| Polymarket Discord | Discord notifications enabled for #strategy |

Total cost: $0/month (Visualping free tier covers up to 5 pages; the rest is free).

---

## §7 Anti-patterns

Things to NOT do with this watch list:

- **Don't auto-trade off any of these signals.** The scanner has a state machine for a reason; same applies to structural changes. New regulatory tweet → write hypothesis, don't fire orders.
- **Don't expand to 30+ sources.** The watch list is high-leverage *because* it's curated. Add a source only if it has ≥2 unique signals over 6 months that the existing sources missed.
- **Don't skip a week.** Compound effect — missed signals stack. Two missed weeks usually means a structural change happened that you didn't catch until it bit a hypothesis.
- **Don't read these sources during build/coding hours.** Reserve them for the Sunday review ritual. Otherwise they become a context-switch sink.

---

## §8 Quarterly review

Every 3 months, re-evaluate the watch list itself:

- [ ] Which sources actually produced actionable signals in the past 90 days?
- [ ] Which sources were dead weight?
- [ ] Add any new sources that emerged
- [ ] Remove any sources that produced nothing for 2+ quarters
- [ ] Adjust cadence based on signal density

Target steady state: 8–12 sources total, average 1 actionable signal per week across all sources.

---

## Appendix A: Cross-reference

- `~/Documents/Claude/Projects/Prediction Machine/scanner-handoff-brief-2026-05-06.md` §7 — origin source list
- `scanner-plan-v1.md` §4.1 — reference pollers in the active-source ladder
- `hypothesis-tracker-template.md` §7 — how watch-list signals enter the weekly review

## Appendix B: Inbox folder

New hypothesis sketches captured during weekly review go to:
`~/prediction-machine/docs/strategies/inbox/YYYY-MM-DD.md`

Format: one-line per signal, with date and source. Promote to full hypothesis (move to `active-hypotheses/H-YYYY-NNN.md` and insert row in `pmci.hypotheses`) when ready.
