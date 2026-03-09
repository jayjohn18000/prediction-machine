import test from "node:test";
import assert from "node:assert/strict";
import { createPmciClient, getProviderIds } from "../../lib/pmci-ingestion.mjs";

test("PMCI client connects and provider IDs are available", async (t) => {
  const client = createPmciClient();
  if (!client) {
    t.skip("DATABASE_URL not set; PMCI client unavailable");
  }

  await client.connect();
  try {
    const ids = await getProviderIds(client);
    assert.ok(ids && typeof ids.kalshi === "number" && typeof ids.polymarket === "number");
  } finally {
    await client.end();
  }
});

