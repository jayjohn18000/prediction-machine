import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(__dirname, "../../lib/ingestion/sports-universe.mjs"),
  "utf8",
);

test("fetchJson uses fetchWithTimeout (not bare fetch)", () => {
  assert.match(
    source,
    /import\s*\{[^}]*fetchWithTimeout[^}]*\}\s*from/,
    "sports-universe must import fetchWithTimeout from retry.mjs",
  );
  assert.match(
    source,
    /fetchWithTimeout\s*\(\s*url/,
    "fetchJson must delegate to fetchWithTimeout",
  );
});

test("fetchKalshiWithRetry tries all bases before throwing on final attempt", () => {
  const fnMatch = source.match(
    /async function fetchKalshiWithRetry[\s\S]*?^}/m,
  );
  assert.ok(fnMatch, "fetchKalshiWithRetry function must exist");
  const fnBody = fnMatch[0];

  assert.ok(
    !fnBody.includes("if (attempt === maxRetries) throw err"),
    "Must NOT throw inside the inner KALSHI_BASES loop (old bug pattern)",
  );

  assert.match(
    fnBody,
    /if\s*\(\s*attempt\s*===\s*maxRetries\s*\)\s*throw\s+lastErr/,
    "Must throw lastErr AFTER the inner bases loop exhausts all bases",
  );
});

test("ingestProviderMarket calls pass skipEmbedding: true", () => {
  const callCount = (source.match(/skipEmbedding:\s*true/g) || []).length;
  assert.ok(
    callCount >= 2,
    `Expected at least 2 skipEmbedding: true calls (Kalshi + Polymarket), found ${callCount}`,
  );
});

test("backfillEmbeddings is imported and called after ingestion", () => {
  assert.match(
    source,
    /import\s*\{[^}]*backfillEmbeddings[^}]*\}\s*from/,
    "sports-universe must import backfillEmbeddings",
  );
  const callCount = (source.match(/backfillEmbeddings\s*\(/g) || []).length;
  assert.ok(
    callCount >= 2,
    `Expected at least 2 backfillEmbeddings calls, found ${callCount}`,
  );
});

test("Polymarket sports passes bestBidYes and bestAskYes", () => {
  const polySection = source.slice(source.indexOf("ingestPolymarketSports"));
  assert.match(
    polySection,
    /bestBidYes:\s*parseNum\(m\?\.bestBid\)/,
    "Polymarket sports must parse bestBid from market data",
  );
  assert.match(
    polySection,
    /bestAskYes:\s*parseNum\(m\?\.bestAsk\)/,
    "Polymarket sports must parse bestAsk from market data",
  );
});
