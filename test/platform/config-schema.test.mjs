import test from "node:test";
import assert from "node:assert/strict";
import { getConfigFromEnv, getPmciApiConfig } from "../../src/platform/config-schema.mjs";

test("getConfigFromEnv applies defaults", () => {
  const cfg = getConfigFromEnv({ DATABASE_URL: "postgres://u:p@localhost:5432/db" });
  assert.equal(cfg.PORT, 8787);
  assert.equal(cfg.PMCI_MAX_LAG_SECONDS, 120);
  assert.equal(cfg.PMCI_RATE_LIMIT_MAX, 60);
  assert.equal(cfg.PG_POOL_MAX, 10);
});

test("getConfigFromEnv requires DATABASE_URL", () => {
  assert.throws(() => getConfigFromEnv({}), /DATABASE_URL/);
});

test("getPmciApiConfig returns normalized shape", () => {
  const out = getPmciApiConfig({
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    PORT: "9000",
    PMCI_RATE_LIMIT_MAX: "77",
  });
  assert.equal(out.port, 9000);
  assert.equal(out.rateLimitMax, 77);
  assert.equal(out.dbUrl, "postgres://u:p@localhost:5432/db");
});
