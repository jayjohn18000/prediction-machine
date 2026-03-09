import test from "node:test";
import assert from "node:assert/strict";
import { getNewMarkets, listProviders } from "../../src/services/markets-service.mjs";

test("listProviders maps rows", async () => {
  const out = await listProviders({
    query: async () => ({ rows: [{ code: "kalshi", name: "Kalshi" }] }),
    SQL: { providers: "sql" },
  });
  assert.deepEqual(out, [{ code: "kalshi", name: "Kalshi" }]);
});

test("getNewMarkets returns invalid_since for bad since", async () => {
  const out = await getNewMarkets({
    query: async () => ({ rows: [] }),
    resolveProviderIdByCode: async () => 1,
    parseSince: () => null,
    SQL: { new_markets: "sql" },
    providerCode: "kalshi",
    category: undefined,
    since: "bad",
    limit: 10,
  });
  assert.equal(out.error, "invalid_since");
});
