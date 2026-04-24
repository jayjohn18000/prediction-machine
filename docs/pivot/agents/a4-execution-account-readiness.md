# Agent A4 — Execution Account Readiness

_Read `docs/pivot/north-star.md` and `docs/pivot/dependency-map.md` before starting. This is an owner task, not an agent task. It runs in parallel with A1, A2, A3 as calendar time, not work time._

## Why this work matters

Even if the backtest (A5) returns GREEN, the live pilot (Phase H) cannot start without funded execution accounts on both venues with working order-placement API keys. Getting those accounts ready takes calendar time — KYC, funding transfers, USDC bridging for Polymarket, Kalshi verification. Weeks, not hours. If you wait until the backtest returns GREEN before starting, the pilot decision gets delayed by however long account readiness takes.

Start the paperwork now so that when the backtest answer lands, the pilot can begin immediately (if GREEN) or no harm is done (if RED — you just don't deploy capital).

## What success looks like

- A funded Kalshi account with API credentials capable of placing, querying, and canceling orders programmatically. Funding at the low end of the pilot range ($5k) is sufficient for readiness — full capital can be added on pilot-start.
- A funded Polymarket account with API credentials capable of placing, querying, and canceling orders programmatically. USDC on-chain at the wallet the API will use, again at low-end pilot scale.
- API keys stored in a secrets manager (Fly secrets, not `.env` committed) with clear naming (`KALSHI_TRADING_API_KEY`, `POLYMARKET_TRADING_PRIVATE_KEY`, etc.).
- A documented "can we place an order right now?" smoke-test procedure for each venue: place a tiny order far from market, verify it lands in the orderbook, cancel it, verify cancellation. Do not run this smoke test until the pilot actually starts — but have it documented so the first live action is confidence-building, not exploratory.

## Scope boundaries

**In scope:**
- Account creation or verification-upgrade on Kalshi and Polymarket for order-placement permissions.
- Funding at the low end of pilot scale.
- API key generation, secret storage, secure documentation.
- A written, unexecuted order-placement smoke test procedure.

**Out of scope:**
- Building the actual execution adapter in code. That belongs to Phase H proper, after the backtest decision.
- Live trading of any kind during this phase.
- Moving large amounts of capital. Low-end readiness funding only.

## Why this is an owner task and not an agent task

KYC requires identity verification tied to the owner's real-world identity. Funding requires banking or wallet actions only the owner can authorize. API keys for trading are credentials only the owner should generate. An agent can help draft the smoke-test procedure or secret-storage schema, but the human loop is the critical actor.

## What "done" requires the owner to prove

1. Both venues show the account with order-placement permission (not just read-only observation).
2. A test read call with the trading credentials succeeds on each venue (not an order — just confirming the credential works).
3. Secrets are in a secure store, not in a committed file.
4. The smoke-test procedure is written down somewhere findable.

## Things to escalate (to self or to partner humans)

- If Kalshi KYC is not passing, that's a personal-admin issue, not a project issue — resolve outside the project.
- If Polymarket requires a specific chain / wallet setup the owner hasn't done before, budget extra calendar days.
- If either venue has a minimum balance requirement higher than expected, flag — it may affect the pilot-capital question.

## What not to do

- Do not start trading "just a little" to test. The first live trade happens only after the backtest decision and only through the Phase H execution adapter.
- Do not deposit more than the low-end pilot scale before the backtest completes. If the answer is RED, you want the money to come back out easily.
