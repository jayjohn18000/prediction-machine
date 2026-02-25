# pmxt (pmxtjs) — Core Ideas & Concepts Summary

Structured extraction of **concepts and design philosophy** from pmxt (unified prediction market SDK). Goal: adopt the ideas for your own multi-platform observer or execution layer, not copy code.

**Sources:** [pmxt GitHub](https://github.com/pmxt-dev/pmxt), [pmxt.dev/docs](https://www.pmxt.dev/docs), [pmxt.dev](https://pmxt.dev/).

---

## 1. What it is

**One sentence:** pmxt is a **unified API layer** for prediction markets—often described as "ccxt for prediction markets"—that normalizes data and trading across Polymarket, Kalshi, Limitless, Baozi, and Myriad so you use one interface instead of many.

**Target use case:** Apps and systems that need to **read data** (markets, events, order books, OHLCV, trades) or **place/cancel orders** across multiple prediction-market platforms without rewriting logic per exchange. Typical users: dashboards, aggregators, bots, research tools, and execution layers that want "one integration layer" for all supported venues.

---

## 2. Core ideas / philosophy

- **One integration layer for many exchanges**  
  Different platforms use different APIs, formats, and conventions. The core idea is to provide a **single, consistent surface** (same method names, same mental model) so application code doesn't branch on "if Polymarket do X, if Kalshi do Y."

- **Sidecar, not in-process**  
  The **sidecar pattern** is a central design choice: a separate Node.js server sits between the SDKs (Python, TypeScript) and the exchange APIs. SDKs are thin HTTP clients that talk to this server; they do **not** implement exchange logic. All exchange integrations live in one place (the core), so adding a new exchange automatically makes it available to every SDK. Tradeoff: you depend on a running sidecar (and its lifecycle), but you get a single implementation and easy multi-language support.

- **Contract-first API**  
  The sidecar's surface is defined by an **OpenAPI schema** (`openapi.yaml`). That schema is the contract: it drives codegen for SDK clients and ensures the same endpoints and types everywhere. New capabilities = update the schema and regenerate; no ad-hoc divergence between languages.

- **Unified API + "implicit" exchange API**  
  Each exchange is modeled with two layers: (1) a **unified API** (e.g. `fetchMarkets`, `createOrder`) that your app calls, and (2) an **implicit API**—methods generated from each exchange's own OpenAPI spec. Unified methods call into the implicit API (e.g. `callApi('GetMarketOrderbook', { ticker: id })`) and then map responses into shared types. So: one public surface, many backend specs, with mapping in the middle.

- **Auth per exchange, not global**  
  Credentials are **per-exchange** and passed when constructing the client (e.g. Polymarket: private key + optional proxy; Kalshi: API key + RSA private key; Limitless: API key + EIP-712 signing key). There is no single "pmxt login"; each venue keeps its own auth model, and the layer just forwards the right credentials to the right backend.

---

## 3. Key concepts and abstractions

- **Hierarchy: Event → Market → Outcome**  
  Prediction markets are modeled in three levels: **Event** (broad topic, e.g. "Who will Trump nominate as Fed Chair?"), **Market** (a specific tradeable question), and **Outcome** (the side you trade, e.g. Yes/No, or Up/Down). `fetchEvents` returns events (with nested markets); `fetchMarkets` returns markets (with outcomes). Many operations key off **outcome** (e.g. order book and OHLCV are per-outcome), not raw market ID.

- **Unified types**  
  All exchanges are mapped into the same shapes: **UnifiedMarket** (marketId, title, outcomes, volume, liquidity, yes/no/up/down outcome refs), **UnifiedEvent** (id, title, slug, markets[]), **MarketOutcome** (outcomeId, label, price, priceChange24h), plus **OrderBook**, **Order**, **Trade**, **Position**, **Balance**, **PriceCandle** (OHLCV). The critical ID for books/candles/trades is **outcomeId** (e.g. CLOB token ID on Polymarket, market ticker on Kalshi)—not marketId.

- **Core unified methods (conceptual)**  
  - **Discovery / listing:** `loadMarkets` (load all into a local cache for stable pagination), `fetchMarkets` (search/filter by query, slug, sort, limit), `fetchEvents` (search events).  
  - **Single-item fetch:** `fetchMarket`, `fetchEvent` (by id, slug, outcomeId, etc.).  
  - **Order book & history:** `fetchOrderBook(outcomeId)`, `fetchOHLCV(outcomeId, resolution, limit)`, `fetchTrades(outcomeId)`.  
  - **Trading:** `createOrder` (marketId, outcomeId, side, type, amount, price), `cancelOrder`, `fetchOrder`, `fetchOpenOrders`.  
  - **Account:** `fetchBalance`, `fetchPositions`.  
  - **Helpers:** `getExecutionPrice` / `getExecutionPriceDetailed` (from order book), `filterMarkets` / `filterEvents` (text, criteria, or predicate).  
  - **Real-time (where supported):** `watchOrderBook`, `watchTrades`; some exchanges have exchange-specific watchers (e.g. Limitless AMM prices).

- **How exchanges are abstracted**  
  Each exchange has a directory under core (e.g. `kalshi/`, `polymarket/`, `limitless/`): **auth**, **errors**, **fetch*** modules (fetchMarkets, fetchEvents, fetchOHLCV, etc.), and **utils** (mapping to Unified* types). Fetch modules take something like `callApi` and use it to hit the implicit API, then normalize to UnifiedMarket / UnifiedEvent / OrderBook / etc. So "exchange-specific" lives in mapping and in which implicit operations exist; the rest of the app only sees the unified surface.

- **Auth per exchange**  
  No global auth. You instantiate an exchange client with that venue's credentials (env vars or config). The sidecar receives credentials in the request (or uses a cached instance) and passes them to the right exchange's auth/signing layer. Private endpoints are signed per exchange; the SDK doesn't need to know the details.

---

## 4. How it fits prediction markets

- **Benefits of normalization**  
  - Same calls across Polymarket, Kalshi, Limitless, etc.: e.g. one `fetchMarkets({ query })`, one `fetchOrderBook(outcomeId)`, one `createOrder(...)`.  
  - Same data shapes: events with nested markets, markets with yes/no (or up/down) outcomes, order books and OHLCV keyed by outcomeId.  
  - Easier to build observers (scanners, dashboards, research) and execution layers (single order loop that can target any supported venue).  
  - Migration from other unified APIs (e.g. Dome) is framed as "drop-in replacement" with a codemod, reinforcing the idea that a single abstraction is valuable.

- **Tradeoffs**  
  - **Sidecar dependency:** The JS SDK starts/manages a background sidecar; you must run it (and deal with ports, restarts, `stopServer`/`restartServer`). So there is an operational piece, not just a library.  
  - **Coverage and compliance:** Not every exchange supports every method (e.g. Baozi has no historical OHLCV; Myriad is AMM-based so no open orders; some have synthetic order books from pool ratios). The project tracks "Feature Support & Compliance" per exchange and fails tests when data is missing, so the abstraction is honest about per-venue limits.  
  - **Outcome-centric vs market-centric:** Many operations use **outcomeId**; if your mental model is "market," you must remember to use `market.yes.outcomeId` (or equivalent) for books/candles/trades. The docs stress this explicitly.

---

## 5. Ideas to take away (for a multi-platform observer or execution layer)

**Adopt these concepts without copying code:** (1) **One vocabulary** — Event/Market/Outcome hierarchy and unified method names (fetchMarkets, fetchEvents, fetchOrderBook, fetchOHLCV, createOrder, etc.) so your observer or execution logic speaks one language across venues. (2) **Unified types** — Normalize to a single market/event/outcome/order book/order/trade shape per venue so downstream code doesn't branch on exchange. (3) **Auth per exchange** — Keep credentials and signing per platform; your layer just routes them. (4) **Explicit compliance matrix** — Document which methods each venue supports (and whether data is real or synthetic) so you don't assume feature parity. (5) **Optional sidecar** — If you need multiple languages or want one place to add new exchanges, a small HTTP sidecar with a contract (OpenAPI) and thin SDKs is a proven pattern; if you're single-stack, in-process adapters can still follow the same unified surface. (6) **Stable pagination** — For "all markets" style iteration, the idea of `loadMarkets` then paginate over a cached list avoids reordering/duplication across pages. (7) **Outcome as the key** — Use outcomeId (or your equivalent) for order books, OHLCV, and trades, not only marketId.

---

## 6. Where a screenshot would help

| Location | Why |
|----------|-----|
| **https://www.pmxt.dev/docs** — "Quick Start" and "Methods" | Shows the single, consistent API surface. **Screenshot recommended.** |
| **https://www.pmxt.dev/docs** — "Data Models" (UnifiedMarket, UnifiedEvent, MarketOutcome) | Event → Market → Outcome hierarchy. **Screenshot recommended.** |
| **https://github.com/pmxt-dev/pmxt** — ARCHITECTURE.md "The Sidecar Pattern" | ASCII diagram: SDKs → HTTP → Node server → Exchange APIs. **Screenshot recommended.** |
| **https://github.com/pmxt-dev/pmxt** — core/COMPLIANCE.md | Feature matrix per exchange. **Screenshot recommended.** |

---

*Summary derived from pmxt monorepo (JS + Python), https://www.pmxt.dev/docs and https://pmxt.dev/, and repo docs. No code copied; concepts only.*
