# pmxt Spike Result

**Date:** 2026-03-02
**Goal:** Test if pmxt simplifies Kalshi + Polymarket price fetching vs. raw fetch in observer.mjs.

---

## Finding: npm `pmxt` is the wrong package

The npm package named `pmxt` (installed via `npm install pmxt`) is **not** the library described in `docs/pmxt-core-ideas-summary.md`.

| | npm `pmxt` | pmxt-dev/pmxt (from research) |
|--|-----------|-------------------------------|
| Source | npm registry | https://pmxt.dev / GitHub |
| Exchanges | Polymarket only ("in progress") | Polymarket, Kalshi, Limitless |
| Has dist | No (TypeScript source only) | Yes |
| Orientation | Trading (createOrder, fetchPositions) | Observation + trading unified API |
| Read-only use | Not designed for it | Supported via sidecar |

The library from the research docs is at `pmxt.dev` and may not be published to npm under the name `pmxt`.

---

## Next step to complete the spike

1. Check if the correct library is published to npm under a different name:
   - Search for `@pmxt/core`, `pmxt-dev`, or similar
   - Check https://github.com/pmxt-dev/pmxt directly
2. If available: install it, test a single Kalshi pair fetch with the `USE_PMXT=1` flag
3. Key question: does it handle the public `events?event_ticker=` endpoint (no auth)?
   - Our observer uses Kalshi's public trade-api v2 without RSA-PSS auth
   - If pmxt requires auth for Kalshi market data, it won't replace our fetch

---

## Current status

**Hold.** The observer's raw fetch approach (`lib/retry.mjs` + `fetchWithTimeout`) is stable.
The `USE_PMXT=1` flag is already in `observer.mjs` as a scaffold for when the correct library is confirmed.

Re-evaluate when pmxt-dev/pmxt is confirmed available on npm or as a vendored module.
