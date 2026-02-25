# Research summary: dmitryk4/prediction-market-arbitrage

Structured summary of **dmitryk4/prediction-market-arbitrage** (Kalshi vs Polymarket arb + LLM-assisted matching; FastAPI + Next.js). Ideas and concepts you can reuse—no code copy.

**Source:** [dmitryk4/prediction-market-arbitrage](https://github.com/dmitryk4/prediction-market-arbitrage).

---

## 1. What it is

**One sentence:** A Python + FastAPI + Next.js MVP that **detects potential arbitrage between Kalshi and Polymarket** by normalizing markets into a shared schema, using deterministic pre-filtering and an LLM only for **semantic matching** of "same event / same outcome," then computing edge and exposing results via API and a simple UI.

**Target use case:**  
Detect cross-platform mispricings (edge) → expose via REST API → show in a dashboard; **no execution**. The LLM is used only to decide whether two markets refer to the same event and outcome, not for pricing or trade suggestions.

---

## 2. Core ideas / philosophy

- **Strict "detect → API → UI" split:**  
  Pipeline runs in the backend; the only contract to the outside world is "run detection → return opportunities." The Next.js app is a thin client: one "Run detection" action and a list of opportunities. No streaming, no live order books, no execution.

- **LLM only for semantic matching:**  
  The LLM sees **no prices or trading data**. It only answers: "Are these two markets the same event? Same outcome semantics?" with a confidence and risks. All pricing, edge, and validation are deterministic. This keeps the LLM's role narrow and auditable.

- **Deterministic pre-filtering and validation:**  
  Before the LLM, rules cut the candidate set (binary, active, similar resolution, optional same underlying entity). After the LLM, a second deterministic layer validates (e.g. resolution alignment, same-event/same-outcome from LLM). Only then does arb math run. So: **rules first and last**, LLM in the middle for semantics only.

- **Informational only, no execution:**  
  The repo explicitly avoids order routing, sizing, or latency; it's a "discovery + dashboard" tool. Descriptions and risks are attached to each opportunity so a human can interpret.

---

## 3. Key concepts and abstractions

**Pipeline stages (conceptual):**

1. **Fetch candidates** – Each platform has its own client (Kalshi, Polymarket). They speak platform-specific REST, handle auth, retries, and rate limits, and **only** return a list of normalized `Market` objects.
2. **Normalize for matching** – A single **normalized market schema** (e.g. platform, market_id, question, resolution_time, yes_price, no_price, settlement_description, underlying_entity, is_binary, is_active). Both APIs map their raw responses into this schema so the rest of the pipeline is platform-agnostic.
3. **Pre-filter** – Deterministic rules produce **candidate pairs** (one market per platform). Typical levers: binary only, active only, resolution within a time window, optional same underlying_entity. This reduces the number of pairs sent to the LLM.
4. **Match with LLM** – For each candidate pair, the LLM returns a **semantic match result**: same_event (bool), same_outcome_semantics (bool), confidence, and a list of risks. No prices in, no trade suggestions out.
5. **Validate** – Deterministic checks on LLM-approved pairs: e.g. resolution still within threshold, and "same event + same outcome" confirmed. Pairs that fail are dropped.
6. **Arb math** – On validated pairs only: compute edge (e.g. absolute difference in yes_price, expressed in bps), apply a minimum-edge threshold, and attach a human-readable description and combined risks.
7. **Expose via API** – The pipeline returns a list of **arbitrage opportunity** objects (pair + edge + description + risks). The server exposes this as `GET /api/opportunities` (run pipeline and return JSON). The frontend calls this and displays the list.

**How Kalshi and Polymarket are normalized for matching:**

- Each platform has different field names (e.g. close_time vs endDate, yes_bid vs outcomePrices), status values, and price formats (cents vs 0–1). Each **platform module** is responsible for: parsing datetimes, normalizing prices to a 0–1 scale, inferring binary/active, and mapping to the shared schema (question, resolution_time, yes_price, no_price, underlying_entity, etc.). The pipeline and filters then only see this schema, so **matching logic is written once** against a single abstraction.

**Important abstractions (conceptual):**

- **Market** – Single normalized market (platform-agnostic).
- **MarketPair** – One Kalshi market + one Polymarket market under comparison.
- **LLMSemanticMatch** – LLM output: same_event, same_outcome_semantics, confidence, risks (no pricing).
- **ValidatedMatch** – Pair + LLM result + validation passed/not + validation_issues.
- **ArbitrageOpportunity** – Final output: pair + edge_bps + description + risks (informational only).

---

## 4. How it fits prediction markets

- **Cross-platform, different names/tickers:**  
  Events are the same (e.g. "Will X happen by date Y?") but tickers and wording differ. The pattern is: **normalize** (shared schema) → **narrow** (deterministic filters) → **semantic match** (LLM) → **validate** (deterministic) → **edge** (math). That way you can match "Kalshi ticker XYZ" with "Polymarket question ABC" without hardcoding string rules.

- **"Detect edge → API → UI" as a reusable pattern:**  
  Backend owns: config (keys, thresholds), fetching, normalization, filtering, LLM call, validation, arb math, and a single endpoint that returns opportunities. Frontend owns: trigger (e.g. "Run detection"), loading state, error handling (including 501 for "not implemented"), and rendering opportunities (edge, both questions, description, risks). You can swap or add platforms by adding another fetcher + normalization; the pipeline and UI stay the same.

- **Guarding against LLM drift:**  
  By keeping the LLM to "same event? same outcome?" and running deterministic checks before and after, you avoid relying on the model for numbers or trading logic. Risks are surfaced so humans can judge.

---

## 5. Ideas to take away (one paragraph)

Use a **single normalized market schema** and per-platform adapters that only do fetch + normalize; then a **linear pipeline**: deterministic pre-filter → LLM for semantic "same event / same outcome" only (no prices in or out) → deterministic validation → arb math with a minimum-edge threshold → one **GET /api/opportunities** that runs the pipeline and returns JSON. Frontend: one "Run detection" button and a list of opportunities (edge, both market questions, description, risks). Keep execution and order routing out of scope so the system stays a **detection + API + dashboard** with clear separation: rules and math are deterministic and testable, LLM is only for matching when event names/tickers differ. Config (API keys, min edge bps, max resolution delta, optional LLM batch size) lives in one place so you can tune without touching pipeline logic.

---

## Screenshot recommendations

- **README "High-level architecture" bullet list** – The list that maps each file to its role (config, models, llm_client, filters, arb_math, kalshi_api, polymarket_api, pipeline, main, server, next-frontend) is the clearest one-page architecture overview; a screenshot would serve as a quick reference.
- **README "Running the pipeline locally" / "Running the web app locally"** – Optional; useful only if you want to document exact run commands in a visual way.
