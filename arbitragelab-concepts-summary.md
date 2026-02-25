# ArbitrageLab: Core Ideas & Concepts for Prediction-Market Scoring

Structured summary of **hudson-and-thames/arbitragelab** (Python stat-arb / pairs trading library), extracted for conceptual use in quantitative scoring beyond a simple `execution_score` in prediction markets.

---

## 1. What It Is

**One sentence:** ArbitrageLab is an open-source Python library that gives traders a full set of algorithms from top academic journals to exploit **mean-reverting portfolios** (pairs and multi-asset spreads).

**Target use case:** Building and running **statistical arbitrage** and **pairs trading** strategies: identifying co-moving assets, forming stationary spreads, and trading mean reversion with production-ready implementations tied to peer-reviewed work (e.g. *Journal of Portfolio Management*, *Journal of Financial Data Science*, *Journal of Algorithmic Finance*, Cambridge University Press). The library explicitly aims to cover the **whole range of strategies** in [Krauss’ taxonomy](https://www.econstor.eu/bitstream/10419/116783/1/833997289.pdf) for pairs trading.

---

## 2. Core Ideas / Philosophy

- **Krauss taxonomy as backbone:** The design is organized around [Krauss (2015/2016)](https://www.econstor.eu/bitstream/10419/116783/1/833997289.pdf), which classifies pairs trading into: **(1) Distance**, **(2) Cointegration**, **(3) Time series**, **(4) Stochastic control**, **(5) Other** (PCA, copula, machine learning). ArbitrageLab implements strategies across all of these.

- **“Production-ready” from papers:** Implementations are presented as taken from “the most elite and peer-reviewed journals,” with 15+ strategies from landmark papers, 100% code coverage, and emphasis on **reproducibility, interpretability, and ease of use** for portfolio managers and traders.

- **End-to-end + building blocks:** The library offers both **full strategies** and **strategy-construction tools** (spread selection, hedge ratios, trading rules, tearsheets), so users can either run predefined flows or assemble their own.

- **Beyond pairs:** It supports **n-asset mean-reverting portfolios**, not only classic two-asset pairs (e.g. multivariate cointegration, sparse mean-reverting portfolios, PCA-based spreads).

---

## 3. Key Concepts and Abstractions (Conceptual Only)

| Concept | Meaning |
|--------|--------|
| **Pairs formation / spread selection** | How to choose which assets form a “pair” or portfolio: by **distance** (e.g. correlation, distance correlation, angular distance), **cointegration tests** (Engle–Granger, Johansen), **codependence** (e.g. optimal transport, information-based), or **ML** (e.g. clustering, regressor committees). |
| **Spread / ratio** | A combined series built from the legs (e.g. \(S = \text{leg}_1 - (\text{hedge ratio}_2)\cdot\text{leg}_2 - \ldots\)). The spread is the object that is assumed to be mean-reverting; its “equilibrium” is the relationship you trade. |
| **Hedge ratio** | Weights that balance the legs (e.g. by dollar exposure or stationarity). Methods include OLS, TLS (total least squares), Johansen eigenvector, Box–Tiao, **minimum half-life**, and **minimum ADF t-statistic** — so the spread is as mean-reverting as possible. |
| **Mean reversion** | The spread tends to return to a long-run level (or band). Strength of mean reversion can be quantified (e.g. half-life, ADF, Ornstein–Uhlenbeck parameters). |
| **Entry / exit signals** | When to open and close: e.g. **Z-score rules** (enter when \(\|Z\| \geq \text{entry threshold}\), exit when Z moves by a given **exit delta** in the opposite direction), or **optimal thresholds** from time-series/stochastic-control models (OU, CIR, etc.), or **copula conditional-probability** thresholds. |
| **Z-score (spread)** | \(Z_t = (S_t - \text{MA}(S_t)) / \text{std}(S_t)\) over rolling windows. Measures “how many standard deviations” the spread is from its recent mean; used for entry/exit and for **strength of deviation** (useful for scoring). |
| **Position sizing** | For execution, hedge ratios define how many units of each leg to trade so that the combined position has the desired exposure (e.g. market-neutral) and risk. |

Other recurring ideas: **formation vs. trading period** (fit parameters in-sample, trade out-of-sample with periodic re-estimation); **walk-forward / resampling / Monte Carlo** backtesting; and **vectorized vs. step-by-step** backtest design for multi-leg strategies.

---

## 4. How It Fits Prediction Markets

- You are **not** being asked to depend on ArbitrageLab or implement pairs trading. The fit is **conceptual**: reuse the **ideas** for **quantitative scoring** alongside (or beyond) a raw “arbitrage edge” or `execution_score`.

- **When to add quantitative scoring:**  
  When you care not only that an arb exists, but **how strong** and **how reliable** it is. Analogies from stat-arb that transfer conceptually:
  - **Strength of mean reversion:** Like half-life or ADF on a spread — you can score “how mean-reverting” a relationship is (e.g. between two markets or two outcomes).
  - **Spread Z-score:** Score “how far” current mispricing is from equilibrium (e.g. from a model or historical average), in standard-deviation units.
  - **Quality of the “pair”:** Score how stable the relationship is (e.g. cointegration strength, correlation stability, or a simple distance metric over time).
  - **Entry/exit logic:** Conceptualize “entry” as “enough deviation to act” and “exit” as “reversion or stop” — then you can define scores that reflect “closeness to entry” or “closeness to exit” without implementing full trading.

- **Conceptual toolkit (no code):**
  - **Deviation score:** Something like a Z-score of current value vs. estimated fair value or vs. another market.
  - **Mean-reversion strength score:** A statistic that says “this relationship tends to revert” (e.g. half-life, stationarity test, or simplified proxy).
  - **Stability score:** How stable the relationship is over formation windows (e.g. correlation or cointegration over rolling windows).
  - **Threshold-based logic:** Define “significant” deviation and “reversion” in terms of thresholds (Z or probability), and score opportunities by how far they are from those thresholds.

These are the same **concepts** ArbitrageLab encodes (spread, Z-score, mean reversion, formation/trading, thresholds); you reuse the mental model, not the code.

---

## 5. Ideas to Take Away (One Paragraph)

Treat prediction-market opportunities like **mean-reverting spreads**: you have a “spread” (e.g. price difference or ratio between two outcomes or markets), an “equilibrium” (fair relationship), and a notion of “reversion.” Beyond a single execution or edge metric, you can add **scores** that reflect (1) **how far** the current situation is from equilibrium (e.g. Z-score of mispricing), (2) **how strong** the mean reversion is (e.g. half-life or stationarity of the relationship), and (3) **how stable** the relationship has been (e.g. rolling correlation or cointegration). ArbitrageLab’s taxonomy (distance, cointegration, time series, stochastic control, copula, PCA, ML) is a checklist of **ways to define and measure** these relationships; you can adopt the concepts (formation, spread, hedge ratio, entry/exit thresholds) without using the library, and use them to design quantitative scores that complement a simple `execution_score` and help rank or filter which arbs or mispricings are worth acting on.

---

## Screenshot Recommendations

- **[A Taxonomy of Pairs Trading Strategies](https://hudsonthames.org/definitive-guide-to-pairs-trading/#taxonomy)** — Section “A TAXONOMY OF PAIRS TRADING STRATEGIES” with the five Krauss categories (Distance, Cointegration, Time series, Stochastic control, Other: PCA/Copula/ML) and the taxonomy figure. **Screenshot recommended.**  
- **[Welcome to the Statistical Arbitrage Laboratory](https://hudson-and-thames-arbitragelab.readthedocs-hosted.com/en/latest/index.html)** — Main docs landing (thoroughness / flexibility / credibility, link to API). **Screenshot recommended** for a one-page “what this library is.”  
- **[arbitragelab API index](https://hudson-and-thames-arbitragelab.readthedocs-hosted.com/en/latest/technical/api/arbitragelab/index.html)** — Subpackages list (codependence, cointegration_approach, copula_approach, distance_approach, hedge_ratios, ml_approach, optimal_mean_reversion, other_approaches, spread_selection, stochastic_control_approach, tearsheet, time_series_approach, trading, util). **Screenshot recommended** as a strategy/module map.

---

## Sources

- [hudson-and-thames/arbitragelab (GitHub)](https://github.com/hudson-and-thames/arbitragelab)
- [Welcome to the Statistical Arbitrage Laboratory (Read the Docs)](https://hudson-and-thames-arbitragelab.readthedocs-hosted.com/en/latest/index.html)
- [arbitragelab API — arbitragelab 1.0.0 documentation](https://hudson-and-thames-arbitragelab.readthedocs-hosted.com/en/latest/technical/api/arbitragelab/index.html)
- [The Comprehensive Introduction to Pairs Trading (Hudson & Thames)](https://hudsonthames.org/definitive-guide-to-pairs-trading/)
- [Bollinger Bands Strategy (Z-Score) — arbitragelab docs](https://hudson-and-thames-arbitragelab.readthedocs-hosted.com/en/latest/trading/z_score.html)
- [Hedge Ratio Calculations — arbitragelab docs](https://hudson-and-thames-arbitragelab.readthedocs-hosted.com/en/latest/hedge_ratios/hedge_ratios.html)
- [Krauss (2015) — Statistical Arbitrage Pairs Trading Strategies: Review And Outlook (econstor PDF)](https://www.econstor.eu/bitstream/10419/116783/1/833997289.pdf)
