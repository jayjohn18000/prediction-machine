#!/usr/bin/env node
/**
 * Integration check: coverage/summary, markets/unlinked, markets/new.
 * Verifies linked + unlinked == total_markets and endpoints return valid shapes.
 * Usage: ensure API is running (npm run api:pmci), then:
 *   node scripts/check-coverage.mjs [baseUrl] [provider]
 * Defaults: baseUrl=http://localhost:8787, provider=kalshi
 */

const baseUrl = process.argv[2] || "http://localhost:8787";
const provider = process.argv[3] || "kalshi";

async function main() {
  const summaryRes = await fetch(
    `${baseUrl}/v1/coverage/summary?provider=${encodeURIComponent(provider)}`
  );
  if (!summaryRes.ok) {
    console.error("coverage/summary HTTP", summaryRes.status, await summaryRes.text());
    process.exit(1);
  }
  const summary = await summaryRes.json();
  if (summary.error) {
    console.error("coverage/summary error", summary);
    process.exit(1);
  }

  const total = Number(summary.total_markets);
  const linked = Number(summary.linked_markets);
  const unlinked = Number(summary.unlinked_markets);
  if (linked + unlinked !== total) {
    console.error(
      "Consistency fail: linked + unlinked != total_markets",
      { linked, unlinked, total }
    );
    process.exit(1);
  }

  const unlinkedRes = await fetch(
    `${baseUrl}/v1/markets/unlinked?provider=${encodeURIComponent(provider)}&limit=10`
  );
  if (!unlinkedRes.ok) {
    console.error("markets/unlinked HTTP", unlinkedRes.status, await unlinkedRes.text());
    process.exit(1);
  }
  const unlinkedList = await unlinkedRes.json();
  if (!Array.isArray(unlinkedList)) {
    console.error("markets/unlinked expected array", unlinkedList?.error);
    process.exit(1);
  }
  if (unlinkedList.length > 10) {
    console.error("markets/unlinked length > limit", unlinkedList.length);
    process.exit(1);
  }

  const newRes = await fetch(
    `${baseUrl}/v1/markets/new?provider=${encodeURIComponent(provider)}&since=24h&limit=10`
  );
  if (!newRes.ok) {
    console.error("markets/new HTTP", newRes.status, await newRes.text());
    process.exit(1);
  }
  const newList = await newRes.json();
  if (!Array.isArray(newList)) {
    console.error("markets/new expected array", newList?.error);
    process.exit(1);
  }
  if (newList.length > 10) {
    console.error("markets/new length > limit", newList.length);
    process.exit(1);
  }

  console.log(
    "pmci:check-coverage",
    "provider=%s total=%d linked=%d unlinked=%d ratio=%.4f unlinked_list=%d new_24h=%d",
    provider,
    total,
    linked,
    unlinked,
    Number(summary.coverage_ratio),
    unlinkedList.length,
    newList.length
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
