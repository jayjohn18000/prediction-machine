---
title: Track E — MM runtime triage (2026-05-01)
status: draft
last-verified: 2026-05-01
trigger: post-mm-mvp parallel cleanup orchestration; runtime anomalies surfaced in Phase 0'
sources:
  - lib/mm/orchestrator.mjs
  - lib/mm/restart-reconciliation.mjs
  - lib/ingestion/depth.mjs
  - scripts/mm/run-mm-orchestrator.mjs
  - lib/mm/risk.mjs
  - src/routes/mm-dashboard.mjs
  - lib/mm/order-store.mjs
---

## Introduction

Diagnostic-only memo. No production actions were taken from this branch of
work.

## CONTEXT verification vs live state (2026-05-01)

- **Health signals (prompt ~15:55Z):** Re-checked via `curl`
  `https://pmci-mm-runtime.fly.dev/health/mm`. `loopTick` advanced vs
  narrative snapshot. `lastReconcileAt` unchanged at
  `2026-04-30T19:03:23.211Z`. Depth 8/8 connected. **New drift:** non-empty
  `depthTickersStale` and large `depthLastUpdateSecondsAgo` on several
  tickers.

- **Order-placement timeline:** Hourly SQL on `pmci.mm_orders` confirms
  sustained volume through `2026-04-30T18:00Z`, spike `19:00–20:00Z` UTC,
  then depressed rates — same qualitative shape as CONTEXT.

- **Kill-switch storm:** `SELECT reason, COUNT(*)` → 44,372 rows, all
  `daily_loss` — **matches** CONTEXT.

- **Zero `mm_orders.status=filled` with fills:** 121 rows in `pmci.mm_fills`
  (CONTEXT said 118 — small drift); still **zero** `status=filled` on
  orders.

- **Cron writers:** Not re-queried in this session — unchanged from prompt
  unless superseded by operator.

## E.1. Why is `lastReconcileAt` frozen at the boot timestamp?

**Evidence (live):** `/health/mm` reports `lastReconcileAt`:
`2026-04-30T19:03:23.211Z` with `startedAt` one second earlier;
`loopTick` moves; phase `W4`.

**Evidence (code):** `lastReconcileAt` is assigned **once** after
`reconcileOnRestart` at loop init, never in the steady-state `while`
loop (`lib/mm/orchestrator.mjs`).

```533:554:lib/mm/orchestrator.mjs
      const reconciliation = await reconcileOnRestart({
        client,
        trader: traderPre,
        markets: rows,
      });
      // ... merges wmPatch ...
      if (opts.health) {
        /** @type {any} */ (opts.health).lastReconcileAt = new Date().toISOString();
        /** @type {any} */ (opts.health).reconcilePhase = reconciliation.phase;
        /** @type {any} */ (opts.health).reconcileSkipped = reconciliation.skipped;
      }
```

Startup-only reconcile lives in `lib/mm/restart-reconciliation.mjs`; there
is **no** periodic in-loop reconcile updating this field.

**Verdict:** Timestamp reflects **successful one-shot startup reconcile**,
not evidence of a stalled periodic reconciler. Naming encourages a false
“frozen loop” reading.

**Proposed fix (do not apply):** Rename/clarify (e.g.
`lastStartupReconcileAt`), document; only advance on a real cadence if
product adds recurring reconcile.

**Operator action required:** Yes — align monitoring semantics; decide if
periodic reconcile is required.

## E.2. Did depth-feed disconnect leave the internal book stale?

**Evidence (live):** WS 8/8 connected but health lists stale tickers plus
large `depthLastUpdateSecondsAgo` on sample pull.

**Evidence (code):** Reconnect wipes ladders via
`resetDepthStateForReconnect` before backoff reconnect; snapshot gate via
`snapshotReceived`. Git merges `7999601`, `055236a` carry reconnect work.

```471:487:lib/ingestion/depth.mjs
  const scheduleReconnect = (trigger) => {
    // ...
    resetDepthStateForReconnect(books, marketTickers, snapshotReceivedMap);
    // ... backoff ...
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      attachSocket();
    }, nextDelayMs);
  };
```

**Verdict:** After reconnect the book is **not** silently reusing old
merge state; staleness means missing fresh Kalshi snapshots/deltas.

W4 `processMarketRow` uses **REST** `fetchKalshiMarketSnapshot` for mid —
WS depth maps feed DB depth + health, not that mid path, unless other
code binds to WS.

**Proposed fix:** Alert on persistent `depthTickersStale`; optional risk
tie-in if business requires WS parity with REST.

**Operator action required:** Yes — correlate stale tickers with DEMO
incidents or subscription limits.

## E.3. Why did placement collapse post `2026-04-30T19:03Z` restart?

Hypothesis scoring (evidence weight):

- **(a) Frozen reconciler blocks quoting:** Low — reconcile is **boot
  only** (E.1); not on the hot path each tick.
- **(b) Kill-switch memory / DB flag throttles:** Low **now** — all
  **enabled** `mm_market_config` rows show `kill_switch_active=false`; gate
  reads DB each session (`lib/mm/risk.mjs`).
- **(c) `daily_loss` always tripped via bad `pnlCents`:** Low on current
  numbers — `fetchPortfolioDailyNetPnLCentsUtc` shaped query returns a
  **large positive** sum today so the gate passes; **however** summing all
  snapshot rows is likely **not** a meaningful single portfolio PnL —
  needs contract review before trusting the gate mathematically.
- **(d) Kalshi DEMO auth / outage / downgrade:** Medium — cannot confirm
  without logs; compatible with sporadic `bid_err` and intermittent
  placement.

Only **eight** markets `enabled=true` at verification — lowers baseline
attempt rate vs prior many-market configurations regardless of gates.

**Verdict:** Among **(a)-(d)**, **(d)** plus **operational surface
narrowing** dominate; **(a)-(c)** fail or are weak against code/DB pulls.

**Proposed fix:** Fix portfolio rollup definition; structured Kalshi errors
on `errored` rows; clarify E.1 health naming to stop false reconcile
chases.

**Operator action required:** Yes — Fly logs around failures; expected
order churn for eight markets × min requote guards.

## E.4. Is `mm_orders.status='filled'` propagation a bug or by design?

**Evidence (live):** Zero `status=filled`; 121 `pmci.mm_fills` rows.

**Evidence (code):** Dashboard splits `/v1/mm/orders` vs `/v1/mm/fills`
(`src/routes/mm-dashboard.mjs`). Placement may map Kalshi `"executed"` →
`filled` once:

```64:68:lib/mm/orchestrator.mjs
export function mapKalshiOrderStatus(s) {
  if (s === "resting") return "open";
  if (s === "canceled" || s === "cancelled") return "cancelled";
  if (s === "executed") return "filled";
  return "open";
}
```

`ingestFillsForTicker` never bumps parent order status. Restart reconcile
writes **`cancelled`** whenever an order id is absent from **resting**
REST list — conflates fills with cancels:

```66:73:lib/mm/restart-reconciliation.mjs
    /** DB rows … not resting on exchange (comment: cancelled/filled). */
    for (const dr of dbRows) {
      // ...
      if (!restingIds.has(kid)) {
        await updateMmOrderStatus(client, dr.id, "cancelled");
```

**Verdict:** **Bug / missing lifecycle** — **`mm_fills`** is the reliable
execution pane; `mm_orders.status=filled` stays empty in practice.

**Proposed fix:** Update parents on fill ingest; reconcile should query
terminal exchange state or infer fills before `cancelled`.

**Operator action required:** Yes — read matched volume from **`mm_fills`**
until patched.

## E.5. `/health/mm` reports `ok: true` during blind failure narratives

(Restated: staleness of `lastReconcileAt` framing + depth disconnect
window.)

**Evidence (live):** `ok: true` while health advertises depth staleness on
some tickers (and E.1 shows `lastReconcileAt` is not a freshness clock).

**Evidence (code):** `ok` drops only on `lastOrchestratorError` or explicit
`health.ok === false` — not depth, not loop quality, not reconcile
cadence:

```127:143:scripts/mm/run-mm-orchestrator.mjs
    return {
      ok: h.lastOrchestratorError ? false : health.ok !== false,
      ...health,
      ...(depthSnap ?? {}),
      // merges depth-derived fields...
    };
```

**Verdict:** **`ok`** ≈ process / exception latch — **not** “inputs
fresh” readiness.

**Proposed fix:** Add composite readiness (heartbeat window, empty
`depthTickersStale` when configured, optional nested `severity`).

**Operator action required:** Yes — treat **`ok`** as liveness until
semantics expand.

## Summary verdict

- **Reconciler unfreeze plan:** Teach E.1 semantics first. No recurring
  reconcile exists to “thaw” via restart alone.
- **Order placement recovery plan:** Misplaced emphasis on periodic
  reconcile **unwarranted**. Investigate **(d)** class causes, `errored`
  payloads, eight-market baseline, PnL rollup contract.
- **Production cutover gate:** Health strata beyond `ok`; coherent
  orders/fills; trusted PnL definition; prefer **`mm_fills`** for fills
  meanwhile.
- **Recommended sequencing:**
  1. Align operator model: `lastReconcileAt` = startup reconcile stamp.
  2. Fix/document `fetchPortfolioDailyNetPnLCentsUtc` accounting.
  3. Capture structured Kalshi faults on `errored` placements.
  4. Specify `mm_orders.status` lifecycle + patch fill + reconcile paths.
  5. Harden `/health/mm` readiness composite.
  6. Then revisit scale / additional venues.
