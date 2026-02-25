# Research Summary: arbbets/Prediction-Markets-Data

Structured summary of **arbbets/Prediction-Markets-Data** (multi-platform data + arb detection + dashboard). Ideas and concepts you can reuse—no code copy.

**Primary source:** [arbbets/Prediction-Markets-Data](https://github.com/arbbets/Prediction-Markets-Data) (README + live product at [GetArbitrageBets.com](https://getarbitragebets.com/)).

---

## 1. What it is

**One sentence:** A Python-based pipeline that collects, normalizes, analyzes, and visualizes prediction-market data from multiple platforms (Kalshi, Polymarket, PredictIt, Limitless, and others) so users can spot arbitrage, compare odds, and run analytics in one place.

**Target use case:** Traders and researchers who want **multi-platform data**, **arbitrage detection**, and **dashboards/reports** (plus CSV/JSON/Excel export) without manually stitching each platform's API and schema.

---

## 2. Core ideas / philosophy

- **Single view across venues:** Treat many prediction markets as one logical "marketplace." The value is in **aggregation and normalization**, not in any one API.
- **Real-time vs batch:** Support both **live feeds** (for arb and trading) and **historical/batch** (for backtests, research, and scheduled reports). Configurable polling lets you choose freshness vs load.
- **Arbitrage detection (concept):** Find **price discrepancies for the same or equivalent events** across platforms. Conceptually: "Same outcome, different implied probability on different venues" → potential risk-free or +EV opportunity. The repo frames this as cross-platform comparison with a dedicated `calculate_arbitrage()`-style capability.
- **Risk assessment (concept):** Use **volatility, confidence intervals, and liquidity** on top of normalized prices—so you can rank markets by "how confident" or "how risky," not just by raw odds.
- **Product split:** The GitHub repo is mostly README/docs; the live product (GetArbitrageBets.com) is where the **scanner, screener, and API** live—so the "stack" is: data layer → analytics → dashboard/API → export.

---

## 3. Key concepts and abstractions

| Layer | Concept | Role |
|-------|--------|------|
| **Data collection** | Multi-platform ingestion | Pull from 15+ sources via live APIs; optional historical backfill; configurable intervals and rate limits. |
| **Normalization** | One schema per "market" | Map each platform's fields into a **standard schema**: id, metadata, odds/prices, volume/liquidity, history, status, confidence/risk. Same mental model whether data came from Kalshi, Polymarket, or PredictIt. |
| **Analytics** | Arb, sentiment, risk | **Arbitrage:** compare normalized prices across platforms. **Sentiment:** use prices/volume as a proxy for crowd view. **Risk:** volatility and confidence intervals. |
| **Visualization / reporting** | Dashboards and reports | Interactive charts, custom dashboards, scheduled reports. The live site acts as the "screener" and arb scanner UI. **Screenshot recommended:** [GetArbitrageBets.com](https://getarbitragebets.com/) homepage and any "Live Opportunities" or screener view. |
| **Export** | CSV, JSON, Excel | Get normalized and/or analyzed data out for spreadsheets, scripts, or other tools. |

The README's **MarketAggregator** is the conceptual hub: add platforms → get markets → get market data / historical data → run arbitrage (and by implication, feed dashboards and exports).

---

## 4. How it fits prediction markets

- **Surfacing opportunities across venues:** One event (e.g. "Candidate X wins") may trade on Polymarket, Kalshi, and PredictIt at different odds. The system's job is to **match equivalent markets**, normalize odds, and flag when the sum of implied probabilities across outcomes (or across platforms) leaves room for arb or +EV.
- **Categories they emphasize:** **Political** (elections, policy, approval, geopolitics), **crypto** (prices, regulation, DeFi), **financial** (rates, GDP, equities, FX), **sports & entertainment** (games, awards, weather). Categories help with filtering and "same event" matching.
- **Live product framing:** GetArbitrageBets.com stresses "200+ daily arbitrage opportunities," "Polymarket vs Kalshi vs Opinion," "real-time," "positive EV," and an **API** for "normalized data" and automation—so the conceptual flow is: collect → normalize → detect arb/EV → expose via dashboard and API.

---

## 5. Ideas to take away (for your own stack)

**Normalize first:** Define one canonical "market" and "outcome" schema (ids, odds, volume, time, status) and map every platform into it. That single abstraction makes cross-venue comparison, arb, and analytics possible. **Then** add a collection layer (per-platform adapters, rate limits, real-time vs batch). On top of that, add an **analytics layer** where "arbitrage" = comparing normalized prices across venues and "risk" = volatility/confidence/liquidity. Expose results via **visualization** (dashboards/screeners) and **export** (CSV, JSON, Excel) so the same pipeline serves traders, researchers, and external tools. Matching "same event" across platforms is the hard conceptual step; the rest is consistent schema + comparison logic and UI/export. The README and the live site together show this flow: multi-platform data → normalization → arb/EV and risk → dashboard + API + export.

---

## Screenshot recommendations

- **GetArbitrageBets.com** — Homepage and "Live Opportunities" or screener view to capture how they present multi-platform arb and screening. **(Screenshot recommended.)**
- **README** — MarketAggregator / architecture overview if present.
