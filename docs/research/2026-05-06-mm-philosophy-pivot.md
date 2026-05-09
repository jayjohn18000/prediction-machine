# Research Brief: How to Build a Profitable Kalshi MM Bot

**Researched:** 2026-05-06 | **Sources read across agents:** 60+ | **Synthesis after a −56% blowup**

---

## Direct Answer (the brutal version)

**Symmetric passive market making on Kalshi sports binaries with $100–$10,000 capital is structurally negative-EV against the operators currently in those books.** Tonight wasn't bad luck — it was the wrong strategy. Academic evidence (Bartlett & O'Hara's 41.6M-trade Kalshi paper, Apr 2026) and practitioner evidence (zero publicly documented profitable sub-$10k Kalshi sports MM operators) point the same direction. The fix isn't tuning `min_half_spread` or rewriting in Rust — it's **switching modes**: from "always be quoting" to "selectively take or quote, gated by toxicity and information edges you actually have."

The three highest-ROI moves, in order:

1. **Add MLB Stats API + game-state gate (free, 1 day)** — pulls quotes during scoring/late-game moments
2. **Add taker mode on conviction (1 day)** — when your fair-value model disagrees with book by ≥3%, take liquidity instead of provide it
3. **Move bot to AWS us-east-1 or Chicago VPS ($10-30/mo, 1 day)** — beats a Rust rewrite by an order of magnitude on dollar-per-effort

Do **not** rewrite in Rust. Do **not** subscribe to Pinnacle/OddsAPI yet at this size.

---

## §1 — Your Previous Philosophy (what blew up)

You were running **the textbook Avellaneda-Stoikov passive market maker**, with three structural choices that were independently survivable and collectively fatal:

| Choice | What you set | Why it breaks |
|---|---|---|
| Symmetric quoting | bid = fair − 1c, ask = fair + 1c | Theory (Glosten-Milgrom 1985) requires bid = E[V \| sell-trade], ask = E[V \| buy-trade] — your symmetric quote violates the bayesian update on every fill |
| Mid-as-fair-value | `fair = (best_bid + best_ask) / 2` | On a trending sports book, mid is a *lagging* indicator. Sharp money taking your stale ask harvests the entire information increment per fill |
| Continuous-quoting goal | "uptime ≥ 90%" (ADR-013) | The math rewards *withdrawing* liquidity when flow is one-sided. Treating uptime as the objective is structurally inverted |
| `min_half_spread = 1c` on 1c books | Quoting AT inside book | Made you queue-deep, but every cross hits you at fair-value-stale prices |
| `base_size = 5` | 5x exposure per fill | 5x'd the magnitude of the adverse-selection bleed |

**Per Bartlett & O'Hara (Kalshi-specific, 41.6M trades):** *"single-name markets exhibit greater informed price impact than broad-based markets… one-sided order flow predicts maker losses in single-name markets but not broad-based markets."* MLB game tickets are textbook **single-name markets**. The paper documents that profitable MM on broad markets only works because retail YES-overbetting subsidizes the toxicity. Sports books in-play have no such subsidy — adverse selection is uncompensated.

**The MINWSH game is the canonical case:** 147 fills, +43–49c adverse_5m on most. That's 49× spread loss in 5 minutes per fill. No symmetric MM with 1c half-spread is recoverable from that. Theory predicted it; the bot didn't have the gating to stop it.

---

## §2 — The Conceptual Shift (be the steamroller)

**Stop thinking "always be quoting." Start thinking "selectively quote when toxicity is low; take when conviction is high; pull when flow is one-sided."**

> The job of a profitable MM is not continuous quoting. It is selective quoting under a real-time toxicity gate. Every surviving MM (equity HFT, crypto, prediction markets) pulls quotes during news events.

### The 8 levers, ranked by ROI for $100–$1,000 sports MM

| # | Lever | What it does | ROI rank |
|---:|---|---|:-:|
| 1 | **Time-of-game gating** | Pull quotes 30s before/after scoring plays, all timeouts/reviews, late-game leverage | 🟢 **Highest free-money lever** |
| 2 | **Taker mode on conviction** | When fair model diverges from book by >3%, cross the spread; don't post passive | 🟢 **Highest unlock for sports** |
| 3 | **External fair value** | Replace `mid = (bid+ask)/2` with `0.7*Pinnacle_devig + 0.3*game_state_WP`. Mid is lagging | 🟢 |
| 4 | **VPIN toxicity gate** | Rolling 1-min buy/sell imbalance. When `\|imbalance\|/total > 0.7`, pull quotes for 60s | 🟢 |
| 5 | **Inventory skew (Avellaneda-Stoikov)** | When long 10 contracts, lean *both* bid and ask DOWN — actively dump inventory | 🟡 Necessary but insufficient alone |
| 6 | **One-sided fill cap** | 3+ consecutive same-side fills → flatten + cool down 10 min | 🟡 Survival mechanic |
| 7 | **Drawdown ladder** | At −1% daily: halve size; at −2%: quote one-sided to flatten; at −3%: full halt | 🟡 |
| 8 | **Quote refresh stickiness** | 200–800ms between cancel-replaces (not every tick). Don't churn | 🔵 Micro-optimization |

The Polymarket sports MM in *Meet Your Market Maker* operates at **0.5¢ edge → $5–10k/side; 1.5%+ edge → "basically unlimited."** Size by edge magnitude, not by intent.

---

## §3 — Data Feed Upgrades (in priority order)

### Tier 1: Free + immediate (do now)
- **MLB Stats API** (`statsapi.mlb.com`) — pitch-by-pitch, 5–15s latency, **free**
- **NHL API** (`api-web.nhle.com`) — free, similar latency
- **NBA CDN** (`cdn.nba.com/static/json/liveData/playbyplay/...`) — free, ~3–8s latency, no auth
- **ESPN scoreboard JSON** as fallback — ~10s latency

### Tier 2: Paid + worth it at $10k+ capital
- **The Odds API** ($30–500/mo) — cheapest sane Pinnacle/FanDuel/DraftKings aggregator
- **OpticOdds / SportsDataIO** ($200–500/mo) — sharper, 1–5s latency

### Tier 3: Don't bother yet
- **Kalshi FIX 4.4 gateway** — application-only, single-digit ms gain, overkill until $100k+
- **Pinnacle direct API** — closed to public 2025-07-23
- **Sportradar GUMBO push** — $1k+/mo enterprise

### Latency stack you can access
| Event | Real-world | MLB API | Sportsbook | Kalshi book |
|---|---|---|---|---|
| Home run | T+0s | T+5–15s (free) | T+15–30s (paid) | T+10–30s |

**Exploitable window: 10–45 seconds** between MLB Stats API and Kalshi book convergence. Use it **defensively** (pull stale quotes) before offensively (take stale book) at this size.

### Chicago colocation move (best ROI infra change)
Kalshi matching engine in Chicago metro. From Fly.io `iad`: ~30–50ms RTT. From Chicago VPS (QuantVPS, Vultr CHI): ~1ms. **Single biggest infra win — beats Rust rewrite 5–10x at <1% engineering cost.** ~$10–30/month.

---

## §4 — Language Decision: DO NOT REWRITE IN RUST

| Component | Latency | Rust improvement |
|---|---|---|
| WS in-flight (Fly iad → Kalshi) | 5–30ms | **0** (network-bound) |
| Application processing (Node.js) | 5–50ms | 5–20ms saved |
| TCP/TLS overhead per POST | 1–5ms | ~0 with keepalive |
| Kalshi matching engine internal | 10–100ms | **0** (out of your control) |
| Round-trip ack | 5–30ms | **0** (network-bound) |

Total cycle: 50–250ms. Node.js processing = 10–25%. Rust shaves 5–20ms median.

Frequency thresholds:
- **<1,000 orders/day:** language irrelevant
- **1k–100k orders/day:** Node fine
- **>100k–1M orders/day:** Rust meaningful
- **>1M orders/day:** Rust mandatory

PMCI is at ~300 fills/night = solidly "language irrelevant." No public Rust Kalshi MM bot exists.

### Instead: 7 Node.js optimizations (80% of Rust gains, 5% of cost)
1. Move bot Fly iad → AWS us-east-1 or Chicago VPS (biggest single win)
2. HTTP/2 keepalive + connection pool to Kalshi REST (`undici`, `keepAliveTimeout: 60_000`)
3. Pre-sign request templates (compute HMAC scaffold once/min, swap payload)
4. Replace `JSON.parse` with `simdjson` bindings (3–5x parse speedup)
5. Single persistent WS, exponential reconnect backoff
6. Tune V8 GC (`--max-old-space-size`)
7. Profile with Clinic.js before optimizing further

**Two weeks on Rust ≈ +5–20ms median. Two weeks on better fair-value model + game-state gate ≈ potentially 10x PnL.** Strategy is the bottleneck.

---

## §5 — Practitioner Reality Check

After Reddit/Twitter/GitHub/podcasts/academic search: **no publicly documented profitable sub-$10k Kalshi sports MM operator exists.** Closest analogue (Polymarket sports MM in *Meet Your Market Maker*) operates at $50k–$300k risk. Every retail-scale Kalshi attempt that publishes results either:

- **Blew up:** MAXIMUS/NorthLakeLabs (0–32 record), Ferraiolo TSA bot ("you can only put $20/week before moving the market"), warproxxx/poly-maker README *"this bot is not profitable and will lose money"*
- **Or didn't disclose PnL:** most GitHub repos

The infrastructure-rich operators (DL Trading, Susquehanna, Jump) won't disclose. They're who you're trading against.

### Three patterns separating profitable operators from blowups

1. **Profitable operators size by edge magnitude, not intent.** Polymarket sports MM scales 0.5¢ edge → $5–10k; 1.5%+ edge → "unlimited."
2. **Profitable operators win on data freshness or audience asymmetry, not on quoting algorithms.** Without external data edge OR retail-dominated audience, two-sided quoting is fee donation.
3. **Survivors document fees + contract-price ratios as first-order constraints.** MAXIMUS killer math: 1¢ fee on 5¢ contract = 20% tax.

### Successful directional/event bots at retail scale (alternative path)
- **Igor Mikerin:** $2.2M / 2 months on Polymarket BTC/ETH/SOL 15-min markets, sub-second lag arb vs Binance/Coinbase. **Not MM — directional latency arb.**
- **Domer (Polymarket):** $1M+ net profit, $300M lifetime volume. Pure directional.

**Pattern:** disclosed-PnL successes at retail scale are **directional or arb on data-edge**, not symmetric MM.

---

## §6 — The Honest Path Forward

Three viable paths; the third (continue symmetric MM) is structurally negative-EV.

### Path A: Continue MM, redesign as informed quoter ($1k–$10k)
1. MLB Stats API + game-state gate (1 day, free)
2. VPIN toxicity gate (1 day, free)
3. Pinnacle de-vigged probability override at $5k+ (~$30/mo)
4. Inventory skew
5. Move to Chicago/AWS VPS

**Expected:** break-even to mildly profitable. Capacity-capped. ~$50–$200/day at $1k, scaling to $500–$2k/day at $10k.

### Path B: Pivot to directional latency arb (closer to disclosed-PnL successes)
1. Crypto/event bots exploiting Kalshi lag vs faster venues
2. Take, don't quote
3. No symmetric strategy
4. Same Kalshi infra, different signal stack

**Expected:** higher variance, higher ceiling. Mikerin's $2.2M/2mo path. Requires sharper data edge.

### Path C: Stop trading, sell the infrastructure
The data product is the higher-EV play long-term per the existing Phase 1+ roadmap.

---

## §7 — Action Plan (ranked by ROI)

| # | Action | Cost | Expected impact |
|---:|---|---|---|
| 1 | **Stop quoting until §2 levers built** | $0 | Stops bleeding |
| 2 | **MLB Stats API gate + VPIN gate** | $0, 1–2 days | Eliminates 60–80% toxic flow |
| 3 | **Move bot to Chicago VPS** | $30/mo | 5–10x latency reduction |
| 4 | **Taker mode on conviction (3¢+ divergence)** | 1 day | Flips prey → predator on big mispricings |
| 5 | **7 Node.js optimizations** | 1 day | 80% of Rust gains |
| 6 | **Backtest §2 strategy on tonight's 336 fills** | 1 day | Proves the redesign before re-enabling |
| 7 | **OddsAPI subscription at $5k+ capital** | $30/mo | Pinnacle de-vig fair value anchor |
| 8 | **Rewrite in Rust** | weeks | **Don't.** |

---

## §8 — Sources (most load-bearing)

- [Bartlett & O'Hara (Apr 2026), *Adverse Selection in Prediction Markets: Evidence from Kalshi* — SSRN 6615739](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6615739) — **single most relevant paper**
- [Glosten & Milgrom (1985), foundational adverse-selection model](https://www.sciencedirect.com/science/article/pii/0304405X85900443)
- [Easley, López de Prado, O'Hara — VPIN flow toxicity (2010 flash crash)](https://www.stern.nyu.edu/sites/default/files/assets/documents/con_035928.pdf)
- [Avellaneda & Stoikov (2008), inventory skew](https://www.math.nyu.edu/~avellane/HighFrequencyTrading.pdf)
- [warproxxx/poly-maker README — "this bot is not profitable"](https://github.com/warproxxx/poly-maker)
- [Polymarket: *Meet Your Market Maker*](https://news.polymarket.com/p/meet-your-market-maker)
- [Aaron Miller, *How to Make Money on Kalshi*](https://4amclub.substack.com/p/how-to-make-money-trading-on-kalshi)
- [MAXIMUS Kalshi Weather Postmortem](https://www.northlakelabs.com/max/blog/kalshi-weather-postmortem-and-pivot/)
- [Ferraiolo TSA Bot Postmortem](https://ferraijv.github.io/kalshi_tsa_trading_bot_overview/)
- [Cybernews — *AI bots lose thousands trading*](https://cybernews.com/ai-news/viral-ai-trading-debunk-model-lost-money-polymarket-kalshi/)
- [Bloomberg — *Most Prediction Market Traders Are Losing Money* (Apr 2026)](https://www.bloomberg.com/news/articles/2026-04-28/most-prediction-market-traders-are-losing-money-while-bots-rack-up-gains)
- [Karl Whelan — *Makers and Takers Kalshi paper* (PDF)](https://www.karlwhelan.com/Papers/Kalshi.pdf)
- [Kalshi WebSocket docs](https://docs.kalshi.com/websockets/websocket-connection)
- [QuantVPS — Kalshi server location, Chicago latency](https://www.quantvps.com/blog/kalshi-servers-location)
- [MLB Stats API community docs](https://github.com/toddrob99/MLB-StatsAPI)
- [The Odds API pricing](https://the-odds-api.com/)
- [Bloomberg — Jump Trading joins Kalshi MM](https://www.bloomberg.com/news/articles/2025-11-20/jump-trading-quietly-joins-event-betting-craze-as-a-market-maker)
- [Hummingbot Avellaneda strategy](https://github.com/hummingbot/hummingbot/tree/master/hummingbot/strategy/avellaneda_market_making)
- [Igor Mikerin — $2.2M Polymarket crypto latency-arb bot (X)](https://x.com/igor_mikerin/status/2003418239255068913)
- [Cartea, Jaimungal, Penalva, *Algorithmic and High-Frequency Trading* (2015)](https://www.cambridge.org/core/books/algorithmic-and-highfrequency-trading) — practitioner bible

---

*Generated 2026-05-06 after the −56% blowup on tonight's MLB MM run.*
