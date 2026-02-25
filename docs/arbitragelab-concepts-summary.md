# ArbitrageLab: Core Ideas & Concepts for Prediction-Market Scoring

Structured summary of **hudson-and-thames/arbitragelab** (Python stat-arb / pairs trading library), extracted for conceptual use in quantitative scoring beyond a simple `execution_score` in prediction markets.

---

## 1. What It Is

**One sentence:** ArbitrageLab is an open-source Python library that gives traders a full set of algorithms from top academic journals to exploit **mean-reverting portfolios** (pairs and multi-asset spreads).

**Target use case:** Building and running **statistical arbitrage** and **pairs trading** strategies: identifying co-moving assets, forming stationary spreads, and trading mean reversion with production-ready implementations tied to peer-reviewed work. The library explicitly aims to cover the **whole range of strategies** in [Krauss' taxonomy](https://www.econstor.eu/bitstream/10419/116783/1/833997289.pdf) for pairs trading.

---

## 2. Core Ideas / Philosophy

- **Krauss taxonomy as backbone:** The design is organized around Krauss (2015/2016), which classifies pairs trading into: **(1) Distance**, **(2) Cointegration**, **(3) Time series**, **(4) Stochastic control**, **(5) Other** (PCA, copula, machine learning). ArbitrageLab implements strategies across all of these.

- **"Production-ready" from papers:** Implementations are presented as taken from peer-reviewed journals, with 15+ strategies from landmark papers, 100% code coverage, and emphasis on **reproducibility, interpretability, and ease of use**.

- **End-to-end + building blocks:** The library offers both **full strategies** and **strategy-construction tools** (spread selection, hedge ratios, trading rules, tearsheets), so users can either run predefined flows or assemble their own.

- **Beyond pairs:** It supports **n-asset mean-reverting portfolios**, not only classic two-asset pairs (e.g. multivariate cointegration, sparse mean-reverting portfolios, PCA-based spreads).

---

## 3. Key Concepts and Abstractions (Conceptual Only)

| Concept | Meaning |
|--------|--------|
| **Pairs formation / spread selection** | How to choose which assets form a "pair" or portfolio: by **distance** (e.g. correlation), **cointegration tests** (Engle–Granger, Johansen), **codependence**, or **ML** (e.g. clustering). |
| **Spread / ratio** | A combined series built from the legs. The spread is the object that is assumed to be mean-reverting; its "equilibrium" is the relationship you trade. |
| **Hedge ratio** | Weights that balance the legs. Methods include OLS, TLS, Johansen eigenvector, **minimum half-life**, and **minimum ADF t-statistic** so the spread is as mean-reverting as possible. |
| **Mean reversion** | The spread tends to return to a long-run level. Strength of mean reversion can be quantified (e.g. half-life, ADF, Ornstein–Uhlenbeck parameters). |
| **Entry / exit signals** | When to open and close: e.g. **Z-score rules** (enter when |Z| ≥ entry threshold, exit when Z moves by exit delta), or **optimal thresholds** from time-series/stochastic-control models. |
| **Z-score (spread)** | Z_t = (S_t - MA(S_t)) / std(S_t) over rolling windows. Measures "how many standard deviations" the spread is from its recent mean; used for entry/exit and for **strength of deviation** (useful for scoring). |
| **Position sizing** | Hedge ratios define how many units of each leg to trade so that the combined position has the desired exposure (e.g. market-neutral) and risk. |

---

## 4. How It Fits Prediction Markets

- The fit is **conceptual**: reuse the **ideas** for **quantitative scoring** alongside (or beyond) a raw "arbitrage edge" or `execution_score`.

- **When to add quantitative scoring:**  
  When you care not only that an arb exists, but **how strong** and **how reliable** it is. Analogies that transfer conceptually:
  - **Strength of mean reversion:** Score "how mean-reverting" a relationship is between two markets or two outcomes.
  - **Spread Z-score:** Score "how far" current mispricing is from equilibrium, in standard-deviation units.
  - **Quality of the "pair":** Score how stable the relationship is (e.g. cointegration strength, correlation stability).
  - **Entry/exit logic:** Conceptualize "entry" as "enough deviation to act" and "exit" as "reversion or stop" — then define scores that reflect "closeness to entry" or "closeness to exit."

- **Conceptual toolkit (no code):**
  - **Deviation score:** Something like a Z-score of current value vs. estimated fair value or vs. another market.
  - **Mean-reversion strength score:** A statistic that says "this relationship tends to revert."
  - **Stability score:** How stable the relationship is over formation windows.
  - **Threshold-based logic:** Define "significant" deviation and "reversion" in terms of thresholds (Z or probability), and score opportunities by how far they are from those thresholds.

---

## 5. Ideas to Take Away (One Paragraph)

Treat prediction-market opportunities like **mean-reverting spreads**: you have a "spread" (e.g. price difference or ratio between two outcomes or markets), an "equilibrium" (fair relationship), and a notion of "reversion." Beyond a single execution or edge metric, you can add **scores** that reflect (1) **how far** the current situation is from equilibrium (e.g. Z-score of mispricing), (2) **how strong** the mean reversion is (e.g. half-life or stationarity of the relationship), and (3) **how stable** the relationship has been (e.g. rolling correlation or cointegration). ArbitrageLab's taxonomy (distance, cointegration, time series, stochastic control, copula, PCA, ML) is a checklist of **ways to define and measure** these relationships; you can adopt the concepts without using the library, and use them to design quantitative scores that complement a simple `execution_score` and help rank or filter which arbs are worth acting on.

---

## Screenshot Recommendations

- **[A Taxonomy of Pairs Trading Strategies](https://hudsonthames.org/definitive-guide-to-pairs-trading/#taxonomy)** — Five Krauss categories and the taxonomy figure. **Screenshot recommended.**
- **[Welcome to the Statistical Arbitrage Laboratory](https://hudson-and-thames-arbitragelab.readthedocs-hosted.com/en/latest/index.html)** — Main docs landing. **Screenshot recommended.**
- **[arbitragelab API index](https://hudson-and-thames-arbitragelab.readthedocs-hosted.com/en/latest/technical/api/arbitragelab/index.html)** — Strategy/module map (subpackages). **Screenshot recommended.**

---

## Sources

- [hudson-and-thames/arbitragelab (GitHub)](https://github.com/hudson-and-thames/arbitragelab)
- [Welcome to the Statistical Arbitrage Laboratory (Read the Docs)](https://hudson-and-thames-arbitragelab.readthedocs-hosted.com/en/latest/index.html)
- [The Comprehensive Introduction to Pairs Trading (Hudson & Thames)](https://hudsonthames.org/definitive-guide-to-pairs-trading/)
- [Krauss (2015) — Statistical Arbitrage Pairs Trading Strategies (econstor PDF)](https://www.econstor.eu/bitstream/10419/116783/1/833997289.pdf)
