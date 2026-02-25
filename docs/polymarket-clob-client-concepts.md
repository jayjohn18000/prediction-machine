# Polymarket CLOB Client — Core Ideas & Concepts

A conceptual summary of **@polymarket/clob-client** (and the Polymarket CLOB ecosystem) so you can adopt the ideas rather than copy code. Primary sources: [Polymarket/clob-client](https://github.com/Polymarket/clob-client) README and structure, [Polymarket Docs](https://docs.polymarket.com/) (Trading, Authentication, Concepts, Market Data, API Reference).

---

## 1. What it is

**One sentence:** The Polymarket CLOB client is a TypeScript (and Python/Rust) SDK for the **Central Limit Order Book (CLOB)** — the order-matching and trading layer of Polymarket’s prediction markets.

**Target use case:** Programmatic **trading** on Polymarket: placing/cancelling limit orders, reading order books and prices, and managing positions. It is *not* the primary tool for discovering events or markets; that role belongs to the Gamma API. Use the CLOB client when you need **execution** (orders, cancellations, heartbeats) or **order-book–centric data** (books, spreads, midpoints, last trade).

---

## 2. Core ideas / philosophy

- **Hybrid-decentralized model:** Matching happens **offchain** (operator); settlement is **onchain** (Polygon, Exchange contract). You get fast matching and non-custodial, onchain-final settlement. The operator cannot set prices or execute unauthorized trades; users can cancel onchain if the API is down.

- **Orders as signed intents:** Orders are **EIP-712 signed messages**. You sign with your private key; the signature authorizes the Exchange contract to execute on your behalf. No custody transfer until a trade is matched and settled.

- **Two-layer auth (L1 → L2):**  
  - **L1:** Private key signs an attestation (EIP-712). Used once to **create or derive** API credentials.  
  - **L2:** API key + secret + passphrase; requests signed with **HMAC-SHA256**. Used for all trading API calls (post order, cancel, heartbeat, get orders/trades).  
  Order *creation* still requires the user to sign the order payload with their key; L2 only authenticates the HTTP request.

- **Wallet vs Magic Link (signature types):** The client is built for multiple “who pays gas / where funds live” models:  
  - **EOA (0):** Your wallet holds funds and pays POL for gas.  
  - **POLY_PROXY (1):** Magic Link / email login; proxy wallet holds funds; export key from [Polymarket](https://polymarket.com/settings) or [reveal.magic.link](https://reveal.magic.link/polymarket).  
  - **GNOSIS_SAFE (2):** Browser or embedded wallet; proxy (Safe) holds funds; most common for Polymarket.com users.  
  You must pass both **signature type** and **funder address** (the address that holds USDC.e / outcome tokens).

- **API layering:**  
  - **Gamma API** — events, markets, tags, search, discovery (no auth).  
  - **CLOB API** — order book, prices, midpoints, spreads, *and* order submission/cancel (auth for trading).  
  - **Data API** — positions, trades, activity, analytics.  
  The CLOB client talks to the CLOB API; market discovery is usually done via Gamma (e.g. get `clobTokenIds` from Gamma, then use those token IDs with the CLOB client).

---

## 3. Key concepts and abstractions

- **Order book:** Central limit order book per **token ID**. Two sides: bids (buy orders) and asks (sell orders). Spread = best ask − best bid. Prices are in [0, 1] and represent implied probability. The CLOB exposes books (and derived prices/spreads) via public endpoints; no auth for reads.

- **Market vs outcome tokens:** A **market** is one binary question (Yes/No) and is identified by a **condition ID**. It has two **outcome tokens** (ERC1155 on Polygon, CTF): one “Yes” and one “No,” each with a **token ID** used on the CLOB. The client places orders by **token ID** (and side). You get token IDs from Gamma (e.g. `clobTokenIds`: first = Yes, second = No) or from CLOB market endpoints.

- **Order types (conceptually):**  
  - **GTC** — Good Till Cancelled; rests until filled or cancelled.  
  - **GTD** — Good Till Date; expires at a set time.  
  - **FOK** — Fill Or Kill; all-or-nothing.  
  - **FAK** — Fill And Kill; fill what’s available, cancel the rest.  
  “Market” orders are limit orders priced to hit the book immediately. **Post-only** means “only add liquidity”; if the order would cross the spread, it is rejected (maker-only).

- **Signing flow (conceptual):**  
  1. **Credentials:** Use L1 (private key + EIP-712) once to create or derive API key/secret/passphrase. Prefer derive so you don’t lose existing creds.  
  2. **Order creation:** Build order payload (nonce, expiry, price, size, side, token ID). Sign it with EIP-712 (private key).  
  3. **Submission:** Send signed order to CLOB with L2 headers (HMAC of request using API secret). Operator validates (tick size, balance, allowances, signature) then either matches or rests the order.  
  4. **Settlement:** When two orders match, the operator submits to the Exchange contract; settlement is atomic (USDC.e and tokens swap).  
  Heartbeats (L2) keep the session alive; otherwise open orders can be auto-cancelled.

- **Tick size and neg_risk:** Each market has a **minimum tick size** (e.g. 0.01) and a **neg_risk** flag (negative risk / multi-outcome structure). The client needs these (e.g. from Gamma or `getMarket`) to build valid orders; wrong tick size or neg_risk can cause rejections.

---

## 4. How it fits prediction markets (CLOB vs Gamma / market data)

- **Gamma API (gamma-api.polymarket.com):** Event/market **discovery and metadata** — events, markets, tags, slugs, `clobTokenIds`, `outcomePrices`, `enableOrderBook`, etc. All public, no auth. Use it to “what markets exist?” and “what are the token IDs and market params?”

- **CLOB API (clob.polymarket.com):** **Order book and execution.** Public: order book, best bid/ask, midpoint, spread, last trade, price history. Authenticated: place/cancel orders, get user orders/trades, heartbeat. Use it to “what’s the book?” and “place/cancel orders.”

- **When to use the CLOB client:**  
  - Building **trading UIs or bots** (limit orders, cancellations, order status).  
  - Needing **order-book–level data** (depth, spread, mid) in code that also trades.  
  - Implementing **market making** or **systematic execution** on Polymarket.  
  Use **Gamma (and optionally Data API)** for discovery, analytics, and positions; use the **CLOB client** when your workflow is “find a market → read book → place/cancel orders.”

---

## 5. Ideas to take away

Use **two APIs in mind**: Gamma for *what* to trade (events, markets, token IDs, metadata) and the CLOB for *how* to trade (order book, orders, execution). Keep **auth in two layers**: L1 for deriving API creds (once), L2 for every trading request; never expose the private key in the backend, and still sign each order with the user’s key. Treat **orders as signed intents** that the operator matches and the chain settles, so design around order lifecycle (create → sign → submit → match/rest → settle) and wallet types (EOA vs proxy + funder). Get **market params** (tick size, neg_risk) from Gamma or CLOB market endpoints before building orders. If you’re building market data only (no trading), public CLOB endpoints plus Gamma are enough; if you’re building execution or market making, the CLOB client (or equivalent signing + L2 headers) is the right abstraction.

---

## Screenshot / diagram suggestions

- **[Authentication](https://docs.polymarket.com/api-reference/authentication)** — L1 vs L2 table and “Signature Types and Funder” table; a small flow (L1 → derive → L2 → trade) would help.  
  **Screenshot recommended.**

- **[Order Lifecycle](https://docs.polymarket.com/concepts/order-lifecycle)** — Create → Sign → Submit → Match/Rest → Settlement.  
  **Screenshot recommended.**

- **[API Introduction](https://docs.polymarket.com/api-reference/introduction)** — Three APIs (Gamma, Data, CLOB) and which is public vs authenticated.  
  **Screenshot recommended.**

- **[Market Data Overview](https://docs.polymarket.com/market-data/overview)** — Table of Gamma vs CLOB vs Data API endpoints.  
  **Screenshot recommended.**

- **GitHub [clob-client README](https://github.com/Polymarket/clob-client)** — Usage snippet and `signatureType` comment (0 vs 1); optional for “first touch” onboarding.

---

## Sources

- [Polymarket/clob-client](https://github.com/Polymarket/clob-client) — README, repo structure, `src/` (client, signing, order-builder, endpoints).
- [Polymarket Docs — Quickstart](https://docs.polymarket.com/quickstart) — Gamma for markets, then CLOB client for orders.
- [Polymarket Docs — Authentication](https://docs.polymarket.com/api-reference/authentication) — L1/L2, signature types, funder.
- [Polymarket Docs — Trading overview](https://docs.polymarket.com/trading/overview) — Hybrid CLOB, auth, client methods.
- [Polymarket Docs — Order lifecycle](https://docs.polymarket.com/concepts/order-lifecycle) — Limit orders, EIP-712, match/rest, settlement.
- [Polymarket Docs — Prices & orderbook](https://docs.polymarket.com/concepts/prices-orderbook) — Prices as probabilities, bid/ask, spread.
- [Polymarket Docs — Markets & events](https://docs.polymarket.com/concepts/markets-events) — Market vs event, condition ID, token IDs.
- [Polymarket Docs — Positions & tokens](https://docs.polymarket.com/concepts/positions-tokens) — Outcome tokens, split/merge/redeem.
- [Polymarket Docs — API introduction](https://docs.polymarket.com/api-reference/introduction) — Gamma, Data, CLOB split.
- [Polymarket Docs — Market data overview](https://docs.polymarket.com/market-data/overview) — Event/market model, which API for what.
- [Polymarket Docs — Clients & SDKs](https://docs.polymarket.com/api-reference/clients-sdks) — TS/Python/Rust, Builder, Relayer.

Note: There is no single `https://docs.polymarket.com/developers/CLOB` page; CLOB content lives under **Trading** and **API Reference** (e.g. `/trading/overview`, `/api-reference/authentication`, `/concepts/order-lifecycle`).
