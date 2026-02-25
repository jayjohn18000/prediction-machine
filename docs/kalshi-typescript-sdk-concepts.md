# Kalshi TypeScript SDK — Core Ideas & Concepts

Structured summary for **conceptual adoption**: design principles, abstractions, and prediction-market flow from the official **kalshi-typescript** SDK and docs. No code to copy—ideas to reuse when building your own integration.

**Sources:** [TypeScript Quickstart](https://docs.kalshi.com/sdks/typescript/quickstart), [SDKs Overview](https://docs.kalshi.com/sdks/overview), [llms.txt index](https://docs.kalshi.com/llms.txt), [MarketsApi](https://docs.kalshi.com/typescript-sdk/api/MarketsApi), [Authenticated Requests](https://docs.kalshi.com/getting_started/quick_start_authenticated_requests), npm package `kalshi-typescript` (API surface).

---

## 1. What it is

**One sentence:** The Kalshi TypeScript SDK is an **OpenAPI-generated**, **type-safe** client for the Kalshi trade API that handles **RSA-PSS request signing** and exposes the API as **domain-specific API classes** (Markets, Portfolio, Orders, etc.).

**Target use case:** Quick integration from Node.js or browsers for trading, market data, and portfolio management—with the caveat that for production, Kalshi recommends either generating your own client from the [OpenAPI spec](https://docs.kalshi.com/openapi.yaml) or integrating directly with the API for full control.

---

## 2. Core ideas / philosophy

- **Spec-first, generated client** — The SDK is produced from the Kalshi OpenAPI specification (OpenAPI-Generator). Versions track the spec; releases are typically weekly (Tuesdays/Wednesdays). The idea: one source of truth (the spec), consistent clients across languages.
- **Typed client** — TypeScript/JavaScript with full type definitions; request/response and model types are first-class so call sites get autocomplete and compile-time checks.
- **Single configuration, many API classes** — You create one **Configuration** (API key, private key, base path). That configuration is passed into **API classes** (e.g. `PortfolioApi`, `MarketApi`, `OrdersApi`). No per-request auth setup; the client handles signing and headers for every call.
- **Auth as a cross-cutting concern** — Authentication is not scattered across endpoints; it’s centralized. The SDK performs **automatic request signing and timestamp handling** so app code stays declarative (“get balance,” “get orderbook”) rather than imperative (“build headers, sign, send”).
- **RSA-PSS signing** — Auth is key-based and signature-based: API Key ID + private key. Every authenticated request is signed (RSA-PSS with SHA-256). The server verifies using the public key associated with the API key. No long-lived bearer tokens; each request proves possession of the private key and binds the request (timestamp + method + path).
- **Explicit base path / environment** — Configuration includes `basePath` (e.g. demo vs production). Encourages explicit environment choice and makes it easy to point at different API instances.
- **Retries and error handling** — SDKs are documented to provide error handling and retries, aligning with production-ready integration patterns.
- **Recommendation for production** — The overview doc explicitly recommends generating your own client from the OpenAPI spec or doing direct API integration for production, positioning the SDK as a fast way to get started rather than the only supported approach.

---

## 3. Key concepts and abstractions

### Configuration

- **Single object** holds: API key ID, private key (file path or PEM string), and base path.
- Private key can be supplied as **path** (`privateKeyPath`) or **inline PEM** (`privateKeyPem`) for different deployment constraints (e.g. server vs serverless, secrets manager).
- **Base path** defines the API root (e.g. `https://api.elections.kalshi.com/trade-api/v2`), so the same code can target demo vs production by changing config.

### API classes (domain slices)

The API is split into **domain-specific classes**, each taking the same Configuration. Conceptually:

| Concept | Role |
|--------|------|
| **AccountApi** | Account-level limits (e.g. API tier limits). |
| **ApiKeysApi** | Create, delete, list, generate API keys (and key pairs). |
| **CommunicationsApi** | RFQs and quotes (request-for-quote / quote flow). |
| **EventsApi** | Events (real-world occurrences), event metadata, event-level candlesticks and forecast percentiles. |
| **ExchangeApi** | Exchange-wide state: status, schedule, announcements, fee changes, user-data timestamp. |
| **FcmApi** | FCM (Futures Commission Merchant) orders and positions (specialized access). |
| **HistoricalApi** | Archived data: historical markets, candlesticks, orders, fills; cutoff timestamps for live vs historical. |
| **MarketApi** | Markets, series, orderbook, candlesticks, trades—core discovery and market data. |
| **MilestoneApi** | Milestones (e.g. for live data). |
| **MultivariateApi** | Multivariate event collections and per-market lookup/creation in those collections. |
| **OrderGroupsApi** | Order groups: create, trigger, reset, limit (rolling-window contract limits, cancel-on-limit). |
| **OrdersApi** | Order lifecycle: create, amend, decrease, cancel, batch create/cancel, queue positions. |
| **PortfolioApi** | Balance, positions, fills, settlements, subaccounts, transfers. |
| **SearchApi** | Discovery (e.g. filters by sport, tags by category). |
| **StructuredTargetsApi** | Structured targets. |
| **IncentiveProgramsApi** | Incentive programs. |
| **LiveDataApi** | Live data by milestone (single and batch). |

So: **one config, many API objects**—each object is a facade over a slice of the HTTP API, with methods that map to endpoints and return typed responses.

### Auth / signing (conceptual)

- **No passwords in requests** — Identity is “API Key ID + proof that you hold the matching private key.”
- **Per-request proof** — Message to sign = `timestamp + HTTP_METHOD + path` (path **without** query string). Sign with RSA-PSS (SHA-256, salt length = digest length), then base64-encode the signature.
- **Three headers** — `KALSHI-ACCESS-KEY` (API key ID), `KALSHI-ACCESS-TIMESTAMP` (current time in milliseconds), `KALSHI-ACCESS-SIGNATURE` (base64 signature). The SDK adds these automatically for authenticated calls.
- **Timestamp** — Ensures requests are fresh and can be rejected if too old (replay protection).
- **Path without query** — Only the path is signed; query params are not part of the signature, so filtering/pagination doesn’t require different signatures for the same logical endpoint.

### Models (typed DTOs)

- The SDK ships **typed models** for every request/response and entity (e.g. `Market`, `Order`, `Orderbook`, `Fill`, `GetBalanceResponse`). These are the “core ideas” of the domain: what a market is, what an order looks like, what the orderbook returns. Building your own integration, you’d still want equivalent DTOs for consistency and validation.

### Pagination

- List endpoints use **cursor-based pagination**: responses include a `cursor`; the next request sends that cursor to get the next page. Empty cursor means no more pages. `limit` (e.g. 1–1000) controls page size. This pattern is consistent across markets, orders, trades, etc.

### Live vs historical split

- **Cutoff timestamps** define the boundary between “live” and “historical” data. Settled markets, old fills, and old orders beyond the cutoff are served from **historical** endpoints; active/resting orders and recent data are on the “live” endpoints. The SDK mirrors this split (e.g. `HistoricalApi` vs `MarketApi` / `PortfolioApi`).

---

## 4. How it fits prediction markets (conceptually)

- **Markets** — A **market** is a single binary outcome (e.g. “Will X happen?”) with yes/no sides, prices in cents (0–100), volume, and settlement rules. Markets live inside **events** (real-world occurrences); events can have many markets. **Series** are templates for recurring events (same structure, settlement source, metadata). So: Series → Events → Markets.
- **Orderbook** — Each market has an **orderbook**: bids (and implied asks) by price level. In binary markets, a yes bid at price X is equivalent to a no ask at (100 − X). The API exposes orderbook depth (e.g. top N levels) for building views or execution logic.
- **Trading flow** — **Orders** are created (optionally in batches), then can be **amended** (price/size) or **decreased** (size). **Cancel** is “decrease to zero.” Orders rest in the book until matched; **fills** represent executed quantity. **Positions** aggregate exposure per market; **balance** and **settlements** complete the account picture. **Order groups** add a layer of risk control (e.g. cap contracts over a rolling window; trigger = cancel group and block new orders until reset).
- **Discovery** — Start from **series** or **events**, then **markets**; filter by status (e.g. open/closed/settled), time, or tickers. **Trades** and **candlesticks** give time-series and liquidity insight. **Multivariate** events model combos of outcomes with their own lookup/creation flow.
- **Data freshness** — **User data timestamp** indicates when balance/orders/fills/positions were last validated; combining this with websocket or polling helps keep UI/algos in sync with the exchange.

So from a “concept” perspective: the SDK is organized so that **discovery** (series, events, markets, orderbook, trades) and **trading** (orders, order groups, portfolio, fills, positions) are clear domains, with **auth** and **environment** centralized in configuration.

---

## 5. Ideas to take away (for your own integration)

Use **one configuration object** for base URL and credentials, and **domain-scoped API facades** (markets, portfolio, orders, etc.) so call sites stay readable and testable. Treat **request signing** as a single, reusable layer: same message format (timestamp + method + path, no query), RSA-PSS + SHA-256, three headers on every authenticated request—and consider generating or sharing this logic across environments (TypeScript, Python, etc.) from a single spec or doc. **Type all request/response and domain models** (markets, orders, orderbook, fills, positions) so your app speaks in terms of the prediction-market domain, not raw JSON. **Cursor-based pagination** and **live vs historical** cutoffs are first-class design choices: support cursors on every list endpoint and separate historical vs live paths where the API does. **Order groups** (or an equivalent) are a useful risk concept: limit exposure over a short window and auto-cancel/block when exceeded. Finally, treat the **OpenAPI spec** as the source of truth: if you need full control in production, generate your client from it or implement a thin HTTP layer with the same auth and types; the SDK’s value is in proving the *concepts* (config, API classes, signing, typing), not in being the only way to integrate.

---

## Screenshot / diagram suggestions

- **SDK overview and feature list** — [https://docs.kalshi.com/sdks/overview](https://docs.kalshi.com/sdks/overview) — *Screenshot recommended* (high-level “what all SDKs provide” and versioning).
- **Auth flow (message = timestamp + method + path, then sign)** — [https://docs.kalshi.com/getting_started/quick_start_authenticated_requests](https://docs.kalshi.com/getting_started/quick_start_authenticated_requests) — *Screenshot recommended* (signing steps and header table).
- **API class ↔ endpoint mapping** — npm package README “Documentation for API Endpoints” table (Class | Method | HTTP request) — *Screenshot recommended* (full API surface at a glance).
