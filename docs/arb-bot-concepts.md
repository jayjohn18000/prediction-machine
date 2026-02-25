# jtdoherty/arb-bot — Core Ideas & Concepts (Conceptual Summary)

**Source:** [jtdoherty/arb-bot](https://github.com/jtdoherty/arb-bot) (README, `main.py`, `arbitrage/arbitrage_bot.py`, `data/order_book.py`, `kalshi/kalshi_client.py).

---

## 1. What it is

**One sentence:** A real-time arbitrage bot that **detects** (and is designed to exploit) price discrepancies between **Polymarket** and **Kalshi** by comparing order books across a **unified vs split** market pair.

**Target use case:** Cross-exchange arbitrage **detection** (and eventual execution): one platform has a single unified market (e.g. "450–499"), the other has two mutually exclusive sub-markets that cover the same outcome (e.g. "450–474" and "475–499"). The bot finds when the combined price on the split side is mispriced relative to the unified side so that YES on one side and NO on the other (or the synthetic equivalent) cost less than $1 per share.

---

## 2. Core ideas / philosophy

- **"Synthetic" arbitrage via split vs unified:**  
  Arbitrage is defined across **one unified market** (Kalshi: one ticker for the whole range) and **two split markets** that are mutually exclusive and exhaustive (Polymarket: 450–474 and 475–499). The invariant: the two Polymarket YES prices should (in theory) sum to the same probability as Kalshi's single YES market. When they don't, you get a **synthetic** arb: e.g. buy YES on the cheap side, sell YES on the expensive side (or the NO-equivalent), so that **combined cost < $1** (or **combined sell > cost**), locking in profit per share.

- **Order book–level comparison, not mid:**  
  Opportunities are derived from **best bid and best ask** on each book, not mid or last trade. So: "poll/stream order books → take top of book per side → compare across platforms" is the core strategy.

- **Async, multi-source data:**  
  - One exchange (Kalshi) is updated via **WebSocket** (orderbook snapshot + deltas).  
  - The other (Polymarket) is updated via **REST** (periodic `get_order_books()`).  
  - A single **OrderBookManager** holds **combined order books** for both venues; the arb logic runs on this normalized view on a fixed interval (e.g. every 5 seconds). So: **async design** = one stream + one poll, merged into one place, then scanned.

- **Detection-first, execution later:**  
  The repo focuses on **identifying and logging** opportunities (profit per share, max size, total profit). Execution is the next step; the core value is the **opportunity detection pipeline** and **pricing formulas**.

---

## 3. Key concepts and abstractions

| Concept | Role |
|--------|------|
| **OrderBookManager** | Owns `combined_order_books` for both venues; exposes `update_order_books()` (pull from both clients) and `compare_specific_markets()` (return normalized, aligned books for the chosen pair). |
| **Market pairing / "compare_specific_markets"** | Maps one Kalshi ticker to two Polymarket token IDs (YES/NO per sub-market). Returns a single structure: Kalshi 450–499 (yes bids/asks), Poly 450–474 (yes bids/asks), Poly 475–499 (yes bids/asks), all in a comparable format. |
| **Normalization** | Kalshi: prices in cents; YES asks are derived from the **NO** book as `1 - price/100`. Polymarket: (price, size) lists; bids sorted descending, asks ascending. Output is a common (price, size) representation per side. |
| **Pricing formulas (two directions)** | **Formula 1:** `(Poly_450_474_Bid + Poly_475_499_Bid) - Kalshi_Ask`. If > 0: sell on Polymarket (hit bids on both), buy on Kalshi (lift ask) → lock profit. **Formula 2:** `Kalshi_Bid - (Poly_450_474_Ask + Poly_475_499_Ask)`. If > 0: buy on Polymarket (lift asks on both), sell on Kalshi (hit bid) → lock profit. |
| **Profit and size** | **Profit** = formula value per share (before fees). **Max size** = `min(kalshi_size, poly_450_474_size, poly_475_499_size)` so all legs can be filled. **Total profit** = profit × max_size. |
| **Opportunity record** | For each opportunity: formula id, type (buy/sell which side), prices per leg, combined Poly price, profit, max_size, total_profit. Enough to log, alert, or feed an execution layer. |
| **Run loop** | Clear → update order books → print comparison → run arb detection → print market details and opportunities → sleep (e.g. 5s). Repeat. Optional separate mode: order-book-only comparison (no arb). |

---

## 4. How it fits prediction markets

- **Pattern:**  
  **Poll/stream order books → normalize and align by market pair → compare top-of-book (best bid/ask) across platforms → apply pricing formulas → flag when profit > 0 → log/store (and optionally execute).**

- **Reusable pieces for your stack (e.g. Node observer):**  
  - **Unified order book view** per platform (and optionally a "combined" view keyed by your internal market id).  
  - **Market mapping**: one "logical" event = one market on A and one or more markets on B (with a rule: e.g. "split YES sums" vs "unified YES").  
  - **Normalization layer**: each venue's API shape (cents vs 0–1, YES/NO vs token ids) → common (price, size) and side (bid/ask).  
  - **Arbitrage formulas**: for split vs unified, two formulas (buy unified / sell split vs buy split / sell unified); for same-event two-way, the same idea with YES vs NO and "sum < 1" or "edge > 0".  
  - **Sizing**: always use `min(size)` across legs for executable quantity.  
  - **Log/store**: timestamp, market ids, prices, profit, max_size, total_profit, and optionally raw books for debugging.

---

## 5. Ideas to take away (one paragraph)

Use a **single "order book observer"** that keeps normalized books for each platform (WebSocket or REST, depending on the API). Define **market pairs** (e.g. one Kalshi market ↔ two Polymarket markets that form a partition). Each cycle: **update books → align by pair → read best bid/ask** from each side, then apply **two formulas** (one per direction: buy A/sell B vs buy B/sell A). Treat **profit > 0** as an opportunity; **max size = min(size across legs)**; log **profit, max_size, total_profit** and whatever identifiers you need. Keep **platform clients** and **order book aggregation** separate from **arbitrage math**, so you can swap venues or add fees later. In Node, this maps cleanly to: an observer that maintains books, a "compare" step that returns comparable books for a pair, and a small "arb detector" that runs the two formulas and emits opportunities.

---

## Screenshot suggestions

- **README "Overview" and "Key Features"** — summarizes unified vs split and real-time monitoring in one place. **(Screenshot recommended.)**
- **Repo root** — `arbitrage/`, `data/`, `kalshi/`, `polymarket/` gives the high-level split (arb logic vs data vs exchange clients). **(Screenshot optional.)**
- There is **no dedicated diagram** in the repo; the README is text-only. A small diagram you could add for your own docs: "Kalshi (1 market) ↔ Polymarket (2 markets) → OrderBookManager → compare_specific_markets → ArbitrageBot formulas → opportunities."
