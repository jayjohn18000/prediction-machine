# Framework & Repo Research — Index

Concept docs for each SDK, repo, and data source. Each file captures **core ideas and concepts** so you can adopt the ideas instead of copying code. Research was done by parallel subagents; screenshots are recommended where noted (URLs listed below).

---

## SDKs (Node/JS)

| Source | Doc | One-line idea |
|--------|-----|----------------|
| **kalshi-typescript** (official) | [kalshi-typescript-sdk-concepts.md](./kalshi-typescript-sdk-concepts.md) | OpenAPI-generated, typed client with RSA-PSS signing and domain API classes (Markets, Portfolio, Orders). |
| **@polymarket/clob-client** (official) | [polymarket-clob-client-concepts.md](./polymarket-clob-client-concepts.md) | TypeScript SDK for Polymarket’s CLOB: order book + trading; Gamma = discovery, CLOB = execution. |
| **pmxtjs** (unified) | [pmxt-core-ideas-summary.md](./pmxt-core-ideas-summary.md) | “ccxt for prediction markets”: one API for Polymarket, Kalshi, Limitless; sidecar + Event/Market/Outcome + outcomeId for books/OHLCV. |

---

## Trading / arbitrage repos (concepts and structure)

| Source | Doc | One-line idea |
|--------|-----|----------------|
| **jtdoherty/arb-bot** | [arb-bot-concepts.md](./arb-bot-concepts.md) | Cross-platform arb (Polymarket vs Kalshi): order book monitoring, unified vs split markets, two pricing formulas, detection-first. |
| **dmitryk4/prediction-market-arbitrage** | [dmitryk4-prediction-market-arbitrage-concepts.md](./dmitryk4-prediction-market-arbitrage-concepts.md) | Detect edge → API → UI; normalized schema; LLM only for semantic “same event / same outcome”; deterministic pre-filter and validation. |
| **arbbets/Prediction-Markets-Data** | [arbbets-prediction-markets-data-concepts.md](./arbbets-prediction-markets-data-concepts.md) | Multi-platform (Kalshi, Polymarket, PredictIt, Limitless) data + normalization + arb detection + dashboard + export (CSV/JSON/Excel). |
| **hudson-and-thames/arbitragelab** | [arbitragelab-concepts-summary.md](./arbitragelab-concepts-summary.md) | Stat-arb / pairs trading from academic papers; Krauss taxonomy; ideas for quantitative scoring (Z-score, mean reversion, stability) beyond execution_score. |

---

## Screenshot recommendations (capture when useful)

Subagents suggested these URLs for screenshots. Use your browser or automation to capture key overview/diagram pages.

### Kalshi TypeScript SDK
- https://docs.kalshi.com/sdks/overview
- https://docs.kalshi.com/getting_started/quick_start_authenticated_requests
- https://www.npmjs.com/package/kalshi-typescript (API Endpoints table)

### Polymarket CLOB
- https://docs.polymarket.com/api-reference/authentication
- https://docs.polymarket.com/concepts/order-lifecycle
- https://docs.polymarket.com/api-reference/introduction
- https://docs.polymarket.com/market-data/overview
- https://github.com/Polymarket/clob-client (README)

### pmxt
- https://www.pmxt.dev/docs (Quick Start, Methods, Data Models, Complete Trading Workflow)
- https://github.com/pmxt-dev/pmxt (README Quickstart, ARCHITECTURE.md sidecar, core/COMPLIANCE.md)
- https://pmxt.dev/ (landing hero)

### arb-bot
- https://github.com/jtdoherty/arb-bot (README Overview & Key Features)

### dmitryk4/prediction-market-arbitrage
- https://github.com/dmitryk4/prediction-market-arbitrage (README High-level architecture, Running locally)

### arbbets/Prediction-Markets-Data
- https://getarbitragebets.com/ (homepage, Live Opportunities / screener)

### ArbitrageLab
- https://hudsonthames.org/definitive-guide-to-pairs-trading/#taxonomy
- https://hudson-and-thames-arbitragelab.readthedocs-hosted.com/en/latest/index.html
- https://hudson-and-thames-arbitragelab.readthedocs-hosted.com/en/latest/technical/api/arbitragelab/index.html

---

## How to use these docs

- **Adopt ideas, not code:** Each doc has a “What it is,” “Core ideas / philosophy,” “Key concepts,” “How it fits prediction markets,” and “Ideas to take away” section.
- **Your stack:** You’re on Node with raw `fetch` to Kalshi trade-api v2 and gamma-api for Polymarket. These concept docs support: (1) wrapping or replacing with kalshi-typescript / clob-client / pmxt, (2) structuring arb detection and market pairing (arb-bot, dmitryk4, arbbets), (3) adding quantitative scoring concepts (arbitragelab).
- **Screenshots:** Capture the URLs above when you want a visual reference for architecture, auth flow, or API surface.
