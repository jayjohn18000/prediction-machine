# PMCI Integration Guide

Connect to the PMCI API from Node.js using the zero-dependency client in `lib/pmci-client.mjs`.

**Related docs:**
- [`docs/api-reference.md`](./api-reference.md) — route cheatsheet, param tables, error reference
- [`docs/openapi.yaml`](./openapi.yaml) — machine-readable OpenAPI 3.1 spec

---

## 1. Environment Setup

Minimum for read-only access:

```bash
PMCI_BASE_URL=http://localhost:8787   # or https://<PMCI_HOST> in production
PMCI_API_KEY=your_api_key_here        # required if server has PMCI_API_KEY set
```

For admin operations (`POST /v1/resolve/link`):

```bash
PMCI_ADMIN_KEY=your_admin_key_here    # required if server has PMCI_ADMIN_KEY set
```

Generate keys with:

```bash
openssl rand -hex 32
```

See `.env.example` for all configurable server-side variables.

---

## 2. Import & Instantiate

```js
import { PmciClient, PmciError } from "./lib/pmci-client.mjs";

const client = new PmciClient({
  baseUrl:  process.env.PMCI_BASE_URL  ?? "http://localhost:8787",
  apiKey:   process.env.PMCI_API_KEY,
  adminKey: process.env.PMCI_ADMIN_KEY,
  // timeoutMs: 15_000  // default
});
```

All constructor options are optional. Omitting `apiKey` works when the server has no `PMCI_API_KEY` set (local dev).

---

## 3. Basic Usage

### Health check (no auth)

```js
const freshness = await client.getHealthFreshness();
console.log(freshness.status);     // "ok" | "stale" | "error"
console.log(freshness.lag_seconds); // seconds since last snapshot
```

### Check projection readiness before querying signals

```js
const proj = await client.getHealthProjectionReady();
if (!proj.ready) {
  console.error("Not ready:", proj.missing_steps);
  process.exit(1);
}
```

### List providers

```js
const providers = await client.getProviders();
// [{ code: "kalshi", name: "Kalshi" }, { code: "polymarket", name: "Polymarket" }]
```

### Coverage for a provider

```js
const cov = await client.getCoverage({ provider: "kalshi", category: "politics" });
console.log(cov.coverage_ratio);       // e.g. 0.73
console.log(cov.unmatched_breakdown);  // [{ reason: "no_family", count: 42 }]
```

### Unlinked markets (gap analysis)

```js
const gaps = await client.getMarketsUnlinked({ provider: "polymarket", category: "politics", limit: 10 });
gaps.forEach(m => console.log(m.title, m.url));
```

### Newly observed markets

```js
// "since" accepts ISO 8601 or relative shorthand
const newMarkets = await client.getMarketsNew({ provider: "kalshi", since: "24h" });
```

---

## 4. Error Handling

All non-2xx responses throw a `PmciError`. Check the convenience getters:

```js
try {
  const signals = await client.getDivergence({ family_id: 42 });
} catch (err) {
  if (err instanceof PmciError) {
    if (err.isStale) {
      // Observer is down. lag_seconds tells you how stale.
      console.error("Data stale:", err.body?.lag_seconds, "seconds");
      console.error("Run: npm run start");
    } else if (err.isUnauthorized) {
      console.error("Invalid PMCI_API_KEY");
    } else if (err.isRateLimited) {
      // Shouldn't normally reach here — the client retries 429 automatically.
      console.error("Rate limited after 3 retries");
    } else {
      console.error("API error", err.status, err.body);
    }
  }
  throw err;
}
```

**Zod validation failures** are returned as HTTP 200 with an `error` field — the client does **not** throw on these:

```js
const result = await client.getCoverage({ provider: "" });
if (result?.error?.fieldErrors) {
  console.error("Validation failed:", result.error.fieldErrors);
}
```

---

## 5. Rate Limit Handling

- Default: 60 requests / 60 seconds per API key (or IP).
- The client automatically retries `429` responses up to **3 times** with full-jitter exponential backoff (base 1000ms, factor 2×).
- If all retries fail, a `PmciError` with `isRateLimited = true` is thrown.
- For bulk operations, throttle at ~1 req/s to stay safely under the limit.

```js
// Bulk example: throttle at ~1 req/s
for (const familyId of familyIds) {
  const links = await client.getMarketLinks({ family_id: familyId });
  console.log(familyId, links.length);
  await new Promise(r => setTimeout(r, 1_100)); // 1.1s gap
}
```

---

## 6. Workflow: Top Divergences

The primary signal workflow. Finds the families with the largest cross-provider price spread.

```js
import { PmciClient, PmciError } from "./lib/pmci-client.mjs";

const client = new PmciClient({
  baseUrl: process.env.PMCI_BASE_URL ?? "http://localhost:8787",
  apiKey:  process.env.PMCI_API_KEY,
});

// Step 1: Confirm system is ready
const proj = await client.getHealthProjectionReady();
if (!proj.ready) {
  console.error("System not ready:", proj.missing_steps);
  process.exit(1);
}

// Step 2: Get canonical event UUID
// Obtain this from `npm run seed:pmci` output, or call /v1/market-families with a known event_id.
const EVENT_ID = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";

// Step 3: Fetch top divergences
let top;
try {
  top = await client.getTopDivergences({ event_id: EVENT_ID, limit: 10 });
} catch (err) {
  if (err instanceof PmciError && err.isStale) {
    console.error(`Observer down — lag ${err.body?.lag_seconds}s. Run: npm run start`);
    process.exit(1);
  }
  throw err;
}

for (const item of top) {
  console.log(`\n${item.label} — max divergence: ${item.max_divergence?.toFixed(4)}`);
  for (const leg of item.legs) {
    console.log(`  ${leg.provider}: ${leg.price_yes} (div=${leg.divergence?.toFixed(4)})`);
  }
}

// Step 4: Drill into links for the top family
const familyId = top[0]?.family_id;
if (familyId) {
  const links = await client.getMarketLinks({ family_id: familyId });
  console.log("\nLinks:", links.map(l => `${l.provider} conf=${l.confidence}`));
}
```

---

## 7. Workflow: Review Queue

Work through proposed link proposals one at a time.

```js
// Fetch one proposal (default limit=1, min_confidence=0.88)
const queue = await client.getReviewQueue({ category: "politics", min_confidence: 0.90 });

if (!queue.length) {
  console.log("Queue empty.");
  process.exit(0);
}

const item = queue[0];
console.log(`Proposal #${item.proposed_id} (confidence: ${item.confidence})`);
console.log(`  A: ${item.market_a.title} @ $${item.market_a.latest_snapshot?.price_yes}`);
console.log(`  B: ${item.market_b.title} @ $${item.market_b.latest_snapshot?.price_yes}`);

// Accept it
const result = await client.postReviewDecision({
  proposed_id:       item.proposed_id,
  decision:          "accept",
  relationship_type: "equivalent",
  note:              "Verified same candidate, same outcome",
});

console.log("Accepted:", result.ok, "family_id:", result.family_id);
console.log("Divergence:", result.divergence_available ? result.divergence_note : "not yet available");
```

To reject or skip:

```js
await client.postReviewDecision({ proposed_id: item.proposed_id, decision: "reject", relationship_type: "equivalent" });
await client.postReviewDecision({ proposed_id: item.proposed_id, decision: "skip",   relationship_type: "equivalent" });
```

---

## 8. Admin: Resolve a Link Directly

Bypasses the review queue. Requires `PMCI_ADMIN_KEY`.

```js
const client = new PmciClient({
  baseUrl:  process.env.PMCI_BASE_URL ?? "http://localhost:8787",
  apiKey:   process.env.PMCI_API_KEY,
  adminKey: process.env.PMCI_ADMIN_KEY, // required
});

const result = await client.resolveLink({
  family_id:          12,
  provider_code:      "kalshi",
  provider_market_id: 999,
  relationship_type:  "equivalent",
  confidence:         0.95,
  reasons:            { source: "manual", analyst: "jaylen" },
});

console.log("Created link_id:", result.link_id, "version:", result.link_version);
```

---

## 9. Smoke Test

Run this against a live API to confirm the client works end-to-end:

```bash
PMCI_API_KEY=your_key node --input-type=module <<'EOF'
import { PmciClient } from "./lib/pmci-client.mjs";
const c = new PmciClient({ apiKey: process.env.PMCI_API_KEY });
const f = await c.getHealthFreshness();
console.log("freshness:", f.status, "lag:", f.lag_seconds, "s");
const p = await c.getProviders();
console.log("providers:", p.map(x => x.code));
EOF
```

Expected output:

```
freshness: ok lag: 45 s
providers: [ 'kalshi', 'polymarket' ]
```
