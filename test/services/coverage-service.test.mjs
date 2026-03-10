import test from "node:test";
import assert from "node:assert/strict";
import { getCoverage, getCoverageSummary } from "../../src/services/coverage-service.mjs";

test("getCoverage returns unknown_provider when provider id is missing", async () => {
  const res = await getCoverage({
    query: async () => ({ rows: [], rowCount: 0 }),
    resolveProviderIdByCode: async () => null,
    SQL: {},
    providerCode: "kalshi",
    category: undefined,
  });
  assert.equal(res.error, "unknown_provider");
});

test("getCoverageSummary maps summary row fields", async () => {
  const res = await getCoverageSummary({
    query: async () => ({ rows: [{ total_markets: 10, linked_markets: 6, unlinked_markets: 4, coverage_ratio: 0.6 }] }),
    resolveProviderIdByCode: async () => 1,
    parseSince: () => null,
    SQL: { coverage_summary: "sql" },
    providerCode: "kalshi",
    category: undefined,
    since: undefined,
  });
  assert.equal(res.provider, "kalshi");
  assert.equal(res.total_markets, 10);
  assert.equal(res.linked_markets, 6);
  assert.equal(res.unlinked_markets, 4);
  assert.equal(res.coverage_ratio, 0.6);
});
