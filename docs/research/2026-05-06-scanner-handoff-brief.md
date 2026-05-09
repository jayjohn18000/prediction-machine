# Scanner Handoff Brief — Plan, Don't Build

**Created:** 2026-05-06 (after a −56% blowup on a symmetric MM bot)
**Author of context:** previous Cowork chat (full transcript reference: `~/prediction-machine/docs/research/2026-05-06-mm-philosophy-pivot.md`)
**Audience:** the next Cowork chat agent picking this up
**Primary objective:** make money with bots, not build infrastructure for its own sake
**Status before this chat:** trading paused; bot disabled; cash $35.31 on Kalshi; 9 zombie orders cancelled

---

## §1 — Read this first (the journey that produced this brief)

Today's chat covered the full arc:

1. **Started the day** running a symmetric Avellaneda-Stoikov maker on Kalshi PROD across 8 manually-seeded MLB games (BOSDET, ATHPHI, BALMIA, MINWSH). Bot config: `min_half_spread=2c → 1c`, `base_size=1 → 5`, `daily_loss=$15-30/market`, `toxicity_threshold=100`.
2. **Discovered MM strategy was structurally wrong** for late-stage sports books via 6 parallel research agents covering: adverse-selection theory, informed MM strategies, Kalshi data feeds, live sports data feeds, language choice (Rust?), and practitioner case studies.
3. **Found the canonical disaster pattern** in our own data: MINWSH game saw 147 fills on a one-way move (WSH 47¢ → 98¢ over 50 min), bot kept selling into the rally and buying the collapsing side. That single game accounted for ~$10–15 of the $55 total drain.
4. **Pulled ground truth from Kalshi API directly** (we wrote `kalshi-pull.mjs` and `kalshi-cancel-resting.mjs` in the repo root). Confirmed: 336 fills since 18:00Z, all 8 MLB games settled with positions = 0, $55.92 cash drain is fully realized.
5. **Cancelled all 9 zombie resting orders.** Bot fully stopped. `mm_market_config.enabled = false` everywhere.
6. **Researched directional latency arb** — concluded the headline trades (Mikerin's $2.2M / 2 months on 15-min crypto) are typically dead by the time they're public; Polymarket killed it with dynamic fees within ~3 months.
7. **Researched edge discovery as a discipline** — Mikerin is an *analyst*, not a trader; his playbook is **wallet archaeology** (find outlier wallets → reverse-engineer strategies). On Kalshi this technique adapts because wallets aren't public.
8. **Settled on Path 2 + Path 1 in parallel** as the only honest move at $45 remaining capital.

**Key existing artifacts** (read in this order):
- `~/prediction-machine/docs/research/2026-05-06-mm-philosophy-pivot.md` — the full research synthesis from the 6-agent dispatch
- `~/prediction-machine/kalshi-pull.mjs` and `kalshi-cancel-resting.mjs` — working Kalshi API clients (use these patterns to extend)
- `~/prediction-machine/CLAUDE.md` — repo invariants (PROD-only since 2026-05-02, single-instance MM, etc.)
- `~/Documents/Claude/Projects/Prediction Machine/` — Obsidian vault with project context

---

## §2 — The strategic frame: Path 2 + Path 1 in parallel

**Path 2 (immediate, $0 capital risk):** trade only the academically-validated structural biases from the [Whelan paper](https://www.karlwhelan.com/Papers/Kalshi.pdf). Slow boring grind. Goal: rebuild capital from $35 → $200+ before any aggressive strategy.

**Path 1 (parallel, no capital risk):** plan the scanner that will produce future hypotheses to test. Goal: **plan only — do not build yet.** The plan is the deliverable from the next chat. The build comes after the plan is reviewed.

**Why both:** Path 2 generates small but real income while Path 1 builds the discovery muscle. If Path 1 produces a validated hypothesis with measured edge, capital from Path 2 funds testing it. If Path 1 fails to produce anything in 4 weeks, Path 2 is still running.

**Hard rule:** scanner planning has a 1-week time-box. If the next chat hasn't produced a complete scanner plan in 7 days, kill the project and put 100% of effort on Path 2.

---

## §3 — Hard constraints (binding for the next chat)

1. **US resident.** No Polymarket account access. Kalshi is the only execution venue. Polymarket data can be *read* (analytics, leaderboards) but not *traded*.
2. **Capital $35.31 cash + $10.50 carryover positions.** Any subscription >$30/month is meaningful. Free tools first.
3. **Chicago VPS deferred.** Do not assume sub-1ms latency. Plan for 30–50ms RTT from Fly iad. Latency-sensitive strategies must measure on real infrastructure before trading.
4. **Plan only.** Do not build the scanner code in the next chat. Do not deploy. Do not trade scanner-derived hypotheses until they've been validated with measurement.
5. **Single Kalshi account.** Multiple accounts violate Kalshi ToS and risk fund seizure (see §8 below for the right approach).
6. **No new bot trading until both:** (a) Path 2 strategy is documented + running on $5–10 test positions, AND (b) scanner plan has been reviewed and approved.
7. **Repo invariants from CLAUDE.md still apply** — PROD-only, single-instance MM, no DEMO fallback, schema validation on migrations.

---

## §4 — The scanner concept (the core deliverable to plan)

**Mental model:** the scanner is **not** a real-time trading system. It's a measurement and discovery tool. It logs candidate inefficiencies for later evaluation. Trading happens in a separate process after a hypothesis is validated.

### The wallet archaeology adaptation for Kalshi (since wallets aren't public)

Mikerin's process on Polymarket: scan leaderboard → find outlier wallet → reverse-engineer strategy. Kalshi's leaderboard is opt-in / opt-out by default, so direct adaptation fails.

The Kalshi adaptation:
- **Read the order book itself as the wallet substitute.** Bot fingerprints in the L2 order book:
  - Repeated identical sizes at off-round prices (e.g., 47 contracts at 0.4731)
  - Asymmetric joint depth (100 on bid, 5 on ask)
  - Quotes that disappear within 1s of small fills (toxicity-aware MM)
  - Quotes that survive 2c book moves (naive MM — fade by taking)
- **Use third-party flow trackers:** [FlowFrame](https://flowframe.xyz/) ($10K+ trades), FORCASTR. The free tier should be sufficient for early discovery.
- **Watch for repeated "concentrated category" patterns** in third-party flow data — same fingerprint Mikerin uses on Polymarket
- **The pillar question for every observed pattern:** *"What feature of this market is this trader/bot exploiting that the consensus order book isn't pricing?"* Write the answer in one sentence before trusting the pattern.

### The 6 inefficiency types to scan for (NOT just informational lag)

The previous chat emphasized this — most retail scanners only hunt informational lag because that's the most-publicized type. Those edges are also the most competed. **The scanner plan must cover all six.**

| Type | Mechanism | Scanner output | Example |
|---|---|---|---|
| **Informational lag** | Public reference data updates faster than market | Divergence > N seconds, edge in cents | Binance WS → Kalshi crypto, MLB Stats API → Kalshi sports |
| **Structural** | Market design creates a wedge | Edge derived from contract spec or fee schedule | Favorite-longshot bias on contracts >$0.50 (positive expected return per Whelan) |
| **Behavioral** | Predictable cognitive biases | Pattern across many markets, not single events | Recency bias in live MLB; lottery preference for <10¢ contracts (>60% loss rate) |
| **Analytical** | Public data exists, no one bothered to model it | Edge from custom modeling effort | Temperature reference-station mismatch (markets resolve on airport, public looks at city center) |
| **Liquidity / capacity** | Edge exists but doesn't scale; whales avoid | Long-tail markets with small books | Niche events with $10–50 books |
| **Resolution-rule** | Settlement criterion ≠ what traders intuitively bet on | Read contract spec carefully | Specific tiebreaker rules in sports; specific weather station/time |

The scanner must be category-aware so each type's output is interpretable on its own terms.

### Conceptual scanner architecture (what to plan, NOT build)

```
DATA SOURCES (per category)
  Crypto: Binance WS aggregate-trade, Coinbase WS, Kraken WS
  MLB: MLB Stats API (free, ~5-15s)
  NHL: api-web.nhle.com (free)
  NBA: cdn.nba.com playbyplay JSON (free)
  Weather: api.weather.gov gridpoints + Open-Meteo (free)
  Economics: BLS news-release page, Cleveland Fed nowcast, FRED API
  Politics: Congress.gov, GovTrack, news API
  ↓
KALSHI MARKET DATA
  WS feeds (markets, trades, fills) + REST polling
  L2 order book snapshots
  Volume profiles
  ↓
SIGNAL FUSION (per market)
  fair_value_estimate = composition of relevant external sources
  book_mid = (best_bid + best_ask) / 2
  spread = best_ask - best_bid
  divergence = abs(fair_value_estimate - book_mid)
  ↓
INEFFICIENCY DETECTION
  For type 1 (informational lag): log when divergence > 3c AND time-since-source-update < N
  For type 2 (structural): cluster trades by price band, output bias by band
  For type 3 (behavioral): time-series detection of pile-ins, recency-correlation
  For type 4 (analytical): custom per-domain (weather station mismatch, etc.)
  For type 5 (capacity): low-volume markets where edge > 2x average spread
  For type 6 (resolution): static analysis of contract specs, flag mismatches
  ↓
HYPOTHESIS LOG (the central output)
  Append-only log of "potential opportunities" with category, mechanism guess, evidence
  Daily summary with rankings
```

The scanner does NOT execute trades. It produces a log + dashboard. Trading is a separate workflow against validated hypotheses.

---

## §5 — Hypothesis tracking system (the user explicitly asked for this)

**The pain point:** without a tracker, you confuse hypotheses, retest things you already killed, can't measure decay over time. Every successful prop trader runs some version of this.

### Proposed schema (markdown file or YAML, kept under version control)

```yaml
hypothesis_id: H-2026-001
name: "MLB late-inning lag — Kalshi reprices 30s-5min after MLB Stats API scoring events"
category: informational_lag
mechanism: |
  Kalshi books are made by humans + slow MMs who don't poll Stats API.
  When a scoring event happens, Stats API exposes it in 5-15s.
  Kalshi book takes 30s-5min to reprice depending on game state.
  Window of edge: take Kalshi side that's stale.
signal_source: statsapi.mlb.com /api/v1.1/game/{gamePk}/feed/live
entry_rules:
  - Stats API event with WPA shift > 5%
  - Kalshi book mid hasn't moved > 2c in last 30s
  - Time-of-game > 3rd inning
  - Game status: in-progress (not delayed/postponed)
exit_rules:
  - Take profit when book reprices to within 2c of fair
  - Hard timeout: 30 min from entry
  - Game-end: hold to settlement
sizing_rules:
  - Max 5% of available cash per trade
  - Max 3 concurrent positions
  - First 10 trades: $5 max position
risk_gates:
  - Pause for the day at -2% portfolio
  - Halt for the week at -5%
  - Halt if hit rate < 30% over 50 trades
falsification_test: |
  If average measured edge < 2c after 100 scanner observations, hypothesis dies.
  If hit rate < 40% over 50 actual trades, hypothesis dies.
status: proposed  # proposed | scanning | testing | live | retired
confidence: high  # high | medium | low | speculative
evidence:
  - link: scanner_log/2026-05-07/mlb-divergence.csv
    note: 23 candidate opportunities measured, avg edge 4.2c
  - link: trade_history/H-2026-001/2026-05-08.csv
    note: 5 paper trades, 4 winners, avg +1.8c after fees
realized_pnl_cents: null  # populated once live
last_validated: 2026-05-07
decay_indicators:
  - If avg edge drops > 30% week-over-week, investigate competition
  - If Kalshi changes MLB market structure (new market types, fee changes), re-test
  - If MLB Stats API latency increases > 30s, hypothesis breaks
```

### Where the tracker lives
- Single markdown file: `~/prediction-machine/docs/strategies/hypothesis-tracker.md`
- Each hypothesis is a section, sortable by status
- Weekly review ritual: scan all hypotheses, update status, retire decayed ones

### The 3 transitions a hypothesis goes through
1. **Proposed** (from scanner output or manual idea) → write the doc above before any code
2. **Scanning** (passively measuring with no trades) — accumulate ≥50 observations
3. **Testing** (paper trades or tiny real trades) — accumulate ≥30 trades
4. **Live** (real money at proportional size) — track weekly
5. **Retired** (decayed or falsified) — keep the doc as institutional memory

The next chat must include hypothesis-tracker design as part of the scanner plan.

---

## §6 — Path 2: published-edge trading (in parallel with scanner planning)

These edges are documented in academic literature with 41.6M Kalshi trades behind them ([Whelan paper](https://www.karlwhelan.com/Papers/Kalshi.pdf)). They don't require a scanner. They're the "boring slow grind" while the scanner plan happens.

**The three rules:**
1. **Buy contracts in the 50–80¢ band** (favorite-longshot bias yields *small positive after-fee returns*)
2. **Never buy contracts <10¢** (lottery loss bias, −60%+ avg outcome)
3. **Always be a maker, never a taker, on entry** (22pp gap between maker and taker outcomes)

**Sizing for the recovery phase:**
- $5 per position, max 5 concurrent positions = $25 deployed
- Daily loss cap: $5
- Halt for the week at −$10
- Goal: $35 → $50 → $100 → $200 over 4–8 weeks

**Markets to focus on initially** (pick from):
- Long-running political markets (2028 nominees) — slow drift, no in-play volatility
- Macro markets with known release schedule (CPI, Fed) — trade well before release
- Long-dated sports series (NHL/NBA series winners) — less in-play noise than single games

**Explicit non-goals:**
- Don't try to MM (your last attempt cost 56%)
- Don't trade in-play sports (the toxic flow that killed you tonight)
- Don't trade contracts <10¢ (lottery zone)
- Don't take liquidity on entry (always maker)

This runs entirely manually for now — no bot. You place 1–3 trades per day via Kalshi UI or simple API calls.

---

## §7 — Sources for tracking structural changes (pre-loaded for the next chat)

These are the leading indicators for new inefficiencies. The scanner plan should consider how to ingest these.

| Source | What you learn | Cadence | Priority |
|---|---|---|---|
| [Kalshi help docs](https://help.kalshi.com) | Market rule changes, fee schedule | Weekly diff via Wayback Machine or Visualping | 🟢 Highest |
| [Kalshi API docs](https://docs.kalshi.com) | Endpoint changes, rate limit shifts | Weekly | 🟢 |
| [CFTC Kalshi filings](https://www.cftc.gov) (search KalshiEx) | New contract approvals (30–90 days lead) | Weekly | 🟢 |
| [Polymarket blog](https://news.polymarket.com) | Strategy patches, fee changes | RSS | 🟡 |
| Kalshi/Polymarket Twitter | Real-time announcements | Follow | 🟡 |
| [r/Kalshi](https://reddit.com/r/Kalshi) | Community patch discussion | Daily, sort by new | 🟡 |
| [4AM Club Substack](https://4amclub.substack.com) | Practitioner analysis | Subscribe | 🟢 |
| Polymarket Discord | Real-time chatter | Lurk | 🟡 |
| LinkedIn job postings (Kalshi, Polymarket) | Product roadmap reveal | Weekly search | 🟡 |
| GitHub mentions of Kalshi/Polymarket | Open-source bot updates | Search alerts | 🔵 |

**The two highest-value free signals:**
1. **CFTC filings** — most authoritative leading indicator of new market types, 30–90 days ahead
2. **Job postings** — hiring patterns reveal product direction 3–12 months ahead

---

## §8 — Multi-account question (no, don't do it)

The user asked: "spinning up multiple Kalshi accounts to track different strategies — okay or not?"

**Answer: don't.** Kalshi ToS allows one account per natural person. Multiple accounts risk:
- Account closure
- Fund seizure
- KYC/AML investigation
- Permanent ban from the platform

**The right approach: single account, multi-strategy attribution.** Tag every order in your own database with `strategy_id` matching a hypothesis. Compute per-strategy PnL from your local DB, not from Kalshi's account dashboard.

```sql
ALTER TABLE pmci.mm_orders ADD COLUMN strategy_id text;
-- e.g., 'H-2026-001', 'H-2026-002', 'manual-published-edge'

-- Per-strategy PnL view
SELECT strategy_id,
  COUNT(*) AS trades,
  SUM(realized_pnl_cents) AS realized_c,
  SUM(...) AS adverse_c
FROM pmci.mm_fills
WHERE observed_at > now() - interval '30 days'
GROUP BY strategy_id;
```

This is exactly what professional prop firms do. Single counterparty, many strategies, attributed locally.

---

## §9 — What the next chat should produce (the deliverables)

The next Cowork chat is for **planning the scanner**. By the end of that chat, these artifacts should exist:

1. **`~/prediction-machine/docs/scanner/scanner-plan-v1.md`**
   - Complete architecture diagram
   - Per-category data source list (with auth/rate-limit notes)
   - Per-inefficiency-type detection logic (pseudocode)
   - Storage schema (where opportunities log)
   - Dashboard concept (how you review weekly)
   - **Explicit non-goals** (what scanner does NOT do)

2. **`~/prediction-machine/docs/strategies/hypothesis-tracker-template.md`**
   - The schema from §5 above, refined
   - Worked example with H-2026-001 (the MLB hypothesis)
   - Review ritual / weekly cadence

3. **`~/prediction-machine/docs/strategies/published-edges-playbook.md`**
   - The 3 Whelan-paper rules from §6
   - Sample trades for the recovery phase
   - Manual workflow (no bot)

4. **`~/prediction-machine/docs/research/source-watch-list.md`**
   - The structural-change tracking sources from §7
   - Subscription instructions
   - Weekly review checklist

5. **(Optional) Decision doc:** scanner architecture choice — buy first vs build first per category. The next chat should evaluate FlowFrame, FORCASTR, OddsJam, etc. for what to subscribe vs build.

**Not in scope for the next chat:**
- Writing scanner code
- Deploying anything
- Trading new strategies
- Onboarding new APIs (just identify them)

---

## §10 — The single most important reminder

**Money-making is the primary objective. The scanner is a means, not an end.**

The trap: scanners can become forever projects. Two weeks of "perfect scanner" beats four weeks of "research without execution." Time-box ruthlessly.

**Decision rule for the next chat:** at the end of 7 days, if the scanner plan isn't complete enough to start building, kill the planning phase and shift 100% to Path 2. The plan is in the way. We'll re-attempt scanner planning after Path 2 has rebuilt capital to $200+.

**Decision rule for after the next chat:** at the end of 14 days post-build-start, if the scanner hasn't produced ≥1 hypothesis with measurable edge >3¢ and frequency >5/day, retire the scanner and compound Path 2 instead.

The pillar from the wallet archaeology principle, restated: *"What feature of this market is this wallet exploiting that the consensus order book isn't pricing?"* Every scanner output should answer this in one sentence. If the scanner produces signals you can't articulate that way, the signal is noise.

---

## §11 — One-paragraph briefing for the next chat (paste this at the top of the new chat)

> I'm continuing work on a Kalshi MM bot that lost 56% of capital today on a symmetric maker strategy. We've researched the failure mode (textbook adverse selection on trending sports books), identified path forward (Path 2 + Path 1 in parallel), and now I want to plan a scanner that will produce future hypotheses to test. Read `~/Documents/Claude/Projects/Prediction Machine/scanner-handoff-brief-2026-05-06.md` for full context, then `~/prediction-machine/docs/research/2026-05-06-mm-philosophy-pivot.md` for the underlying research. The next chat's job is **planning the scanner** (do not build it yet) and designing a hypothesis-tracking system. I'm in the US (Kalshi only), at $35 capital, no Chicago VPS yet, and trading published edges from the Whelan paper in parallel. By end of chat I want: scanner-plan-v1.md, hypothesis-tracker-template.md, published-edges-playbook.md, source-watch-list.md. Time-boxed to 7 days.

---

*End of handoff brief.*
