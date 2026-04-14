# Competitive Baseline: Kalshi ↔ Polymarket Sports Arb Infrastructure
_Researched: 2026-04-14 | Sources: Oddpool, OddsJam, Kalshi fee docs, Polymarket fee docs, academic papers, arb tool registry_

---

## 1. How Many Kalshi↔Polymarket Sports Pairs Do Competitors Track?

**OddPool** is the closest direct competitor — it is specifically built for Kalshi↔Polymarket cross-platform comparison.
- Tracks **800+ markets** across Kalshi, Polymarket, and Opinion in real time
- Sports coverage: NFL, NBA, MLB, NHL, EPL, UEFA, FIFA World Cup, NASCAR, tennis
- Arb scanner covers all three venues simultaneously; **762 arb opportunities found in one tracked week** (their own claim, April 2026)
- Focus: **futures/championship markets** have the most cross-platform overlap; game-level matchup markets have minimal overlap because platforms list different schedules

**OddsJam** has a prediction market section but is not primarily a cross-platform arb tool:
- Covers Kalshi and Polymarket in its "Prediction Traders" and "Prediction Insiders" tracking features
- Not an arb scanner — focused on whale/insider tracking and odds comparison
- Not a direct competitor for the cross-platform link-matching infrastructure PMCI is building

**Other tools with Kalshi+Polymarket arb coverage:**
| Tool | Platforms | Refresh Rate | Notes |
|------|-----------|-------------|-------|
| OddPool | Kalshi, Polymarket, Opinion | 30 seconds | Best direct competitor; has API ($30/mo Pro) |
| Eventarb | Polymarket, Kalshi, Robinhood | Real-time | Free calculator; no dashboard |
| Prediction Hunt | Kalshi, Polymarket, PredictIt | 5 minutes | Cross-exchange arb detection |
| ArbBets | Polymarket, Kalshi + sportsbooks | Unknown | AI-driven EV scanner |
| Claw Arbs | Kalshi, Polymarket, Cloudbet | Real-time | Automated execution (launched April 2026) |

**PMCI position:** With 345 linked pairs as of 2026-04-14, PMCI has meaningful sports futures coverage (MLB WS: 30 teams, NHL Cup: 32 teams, 5 soccer leagues). OddPool's 800+ total market count spans all categories — the comparable sports-futures subset is likely 100–200 equivalent pairs. **PMCI is in range of competitive coverage on futures markets.**

---

## 2. Snapshot/Refresh Interval

| Infrastructure | Refresh Rate |
|---------------|-------------|
| OddPool (arb scanner) | 30 seconds |
| Prediction Hunt | 5 minutes |
| Polytrage | 15 minutes |
| PolyScalping | 60 seconds |
| **PMCI observer (current)** | **4-hour scheduled ingest + continuous observer cycle** |
| **PMCI observer (after OBSERVER_DB_DISCOVERY=1)** | **Continuous per observer cycle (seconds per pair)** |

**Gap:** For futures/championship markets, 4-hour refresh is likely fine — prices on "Who wins the World Series?" don't move second-to-second. For game-level matchup markets (which PMCI currently has minimal coverage of anyway), real-time refresh would matter. **No urgent gap for the futures-focused universe PMCI has.**

---

## 3. Spread Threshold for Actionable Arb

The minimum spread to be profitable after fees depends on both platforms' fee structures.

### Kalshi Taker Fee Formula
```
fee = ceil(0.07 × C × P × (1 - P))
```
- C = number of contracts
- P = contract price (0–1)
- Max fee: **1.75¢ per contract** at P = 0.50
- Maker fee (post-April 2025): **ceil(0.0175 × C × P × (1 - P))** on some markets
- At P = 0.50: taker pays 1.75¢/contract = **1.75% of a $1 contract**

### Polymarket Taker Fee Formula (post-March 2026)
```
fee = C × feeRate × P × (1 - P)
```
- Sports feeRate = **0.75% peak effective rate** (lowest category on Polymarket)
- Max fee: **$0.75 per 100 shares** at P = 0.50 = **0.75¢/share**
- Makers pay zero; 20-25% of taker fees redistributed to market makers

### Combined Fee Math for a 50¢ Market (worst case)
| Side | Fee per contract at P=0.50 |
|------|--------------------------|
| Kalshi taker | 1.75¢ |
| Polymarket taker | 0.75¢ |
| **Combined round-trip** | **2.50¢ = 2.5% of $1** |

**Minimum viable spread:** A spread must exceed **~3–4%** at P=0.50 to clear combined fees plus slippage. Per search data: _"Combined fees of 5%+ mean spreads under 5% are unprofitable"_ — this applies to higher-fee categories; sports-specific is closer to 3–4% minimum.

For **futures markets near certainty** (P = 0.20 or P = 0.80), fees drop significantly:
- Kalshi at P=0.20: 0.07 × 0.20 × 0.80 = 1.12¢/contract
- Polymarket at P=0.20: 0.75% × 0.20 × 0.80 = 0.12¢/contract
- Combined: ~1.24¢ = **1.24% minimum viable spread** at extremes

**Practical threshold used by the market:** Search data indicates 100+ daily arb opportunities are found with spreads ranging **2–8%**. The mean opportunity traders act on appears to be **3–5%** after fees.

---

## 4. Actual Fee Structures (Summary)

### Kalshi
| Fee type | Formula | Max |
|----------|---------|-----|
| Taker | `0.07 × C × P × (1-P)` | 1.75¢/contract at P=0.50 |
| Maker | `0.0175 × C × P × (1-P)` | 0.4375¢/contract at P=0.50 |
| Sports-specific? | No sports carve-out | Same formula applies |

Note: Kalshi's 2025 fee revenue was **$263.5M**, with **89% ($235M) from sports** — sports is by far the dominant category. This means Kalshi sports markets have high volume and liquidity.

### Polymarket
| Fee type | Formula | Max (sports) |
|----------|---------|-------------|
| Taker | `C × feeRate × P × (1-P)` | $0.75/100 shares at P=0.50 |
| Maker | 0 | Zero |
| Sports feeRate | ~0.75% peak | **Lowest category on platform** |

Polymarket rolled out sports fees starting February 18, 2026 (first for NCAA and Serie A), expanded to nearly all categories by March 30, 2026.

---

## 5. How Long Do Opportunities Persist? (Edge Half-Life)

**Game-level / fast markets:**
- Pure arbitrage opportunities on liquid game markets: **2–7 seconds** before automated bots close them
- 78% of arb opportunities in low-volume markets fail due to execution inefficiencies (2025 study)
- These require sub-second execution infrastructure to capture

**Futures/championship markets (PMCI's current focus):**
- Much longer persistence — hours to days
- Price on "MLB World Series winner" moves on game outcomes, roster changes, injuries
- Cross-platform divergences on futures can persist for **hours** before arbitrageurs correct them
- Liquidity is lower, so larger position sizes are harder to fill, but the opportunity window is much wider
- **This is PMCI's natural advantage**: futures markets don't require HFT infrastructure to capture

**Practical implication for PMCI:** The 4-hour observer refresh is sufficient for futures arbitrage. The 30-second OddPool refresh is needed for game-level markets, which PMCI doesn't currently link anyway.

---

## Key Takeaways for Phase F Design

1. **Coverage target:** OddPool tracks ~800 markets total across 3 venues. PMCI's 345 sports-futures links is meaningful — likely comparable to OddPool's futures-only sports subset. Target 500+ links post-E2 (including crypto) to clearly exceed any single competitor.

2. **Minimum actionable spread:** Build Phase F tradability model with a **3% minimum net spread** for 50¢ markets, sliding to **1.5%** for extreme-probability markets. Below these thresholds, fee erosion eliminates edge.

3. **Opportunity persistence:** For futures markets, edges persist **hours to days**. The Phase F "opportunity persistence" metric (F2) should measure this per market type — futures have much longer half-life than game markets.

4. **Refresh rate:** 30-second refresh is OddPool's standard. PMCI's continuous observer with DB discovery enabled hits this for linked pairs. No infrastructure gap for the futures universe.

5. **Fee model for F1:**
   - Kalshi taker: `0.07 × P × (1-P)` per contract
   - Polymarket taker: `0.0075 × P × (1-P)` per share
   - Combined at P=0.50: ~2.5% round trip
   - Use these formulas in the tradability model for net-edge calculation

6. **Claw Arbs (launched April 2026)** is a new entrant doing automated execution across Kalshi + Polymarket. Monitor — if they're executing on the same futures pairs PMCI identifies, they'll compress spreads over time.

---

## Sources

- [Oddpool — Prediction Market Arbitrage Scanner](https://www.oddpool.com/arb-dashboard)
- [Oddpool Pricing](https://www.oddpool.com/pricing)
- [Awesome Prediction Market Tools (GitHub)](https://github.com/aarora4/Awesome-Prediction-Market-Tools)
- [Claw Arbs Launch — FinancialContent](https://www.financialcontent.com/article/marketersmedia-2026-4-11-claw-arbs-launches-automated-arbitrage-software-for-prediction-markets-and-sportsbooks)
- [Kalshi Fee Schedule PDF](https://kalshi.com/docs/kalshi-fee-schedule.pdf)
- [Kalshi Fee Revenue 2025 — Yahoo Finance](https://finance.yahoo.com/news/kalshi-fee-revenue-2025-263-145801350.html)
- [Polymarket Sports Fee Expansion — RootData](https://www.rootdata.com/news/545892)
- [Polymarket Sports Fee Hike Debate — iGaming Business](https://igamingbusiness.com/prediction-markets/polymarket-sports-fee-hike-2026/)
- [Prediction Market Arbitrage Guide — alphascope.app](https://www.alphascope.app/blog/prediction-market-arbitrage-guide)
- [OddsJam Prediction Traders](https://oddsjam.com/prediction/traders)
- [Kalshi Maker/Taker Economics — Whelan Paper (GWU)](https://www2.gwu.edu/~forcpgm/2026-001.pdf)
