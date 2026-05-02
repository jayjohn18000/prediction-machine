// Single source of truth for DEMO↔PROD switching (ADR-011 / ADR-012).
// Verifies that MM_RUN_MODE=prod selects the PROD REST + WS hosts and PROD-suffixed
// secrets, and that DEMO is the default. Each test snapshots+restores process.env.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveKalshiRunMode,
  deriveWsUrlFromRest,
  kalshiEnvFromMode,
  guardKalshiTradingBase,
} from "../../lib/mm/kalshi-env.mjs";

const KEYS = [
  "MM_RUN_MODE",
  "KALSHI_BASE",
  "KALSHI_DEMO_REST_BASE",
  "KALSHI_PROD_REST_BASE",
  "KALSHI_WS_URL",
  "KALSHI_DEMO_WS_URL",
  "KALSHI_PROD_WS_URL",
  "KALSHI_DEMO_API_KEY_ID",
  "KALSHI_API_KEY_ID",
  "KALSHI_PROD_API_KEY_ID",
  "KALSHI_DEMO_PRIVATE_KEY",
  "KALSHI_PROD_PRIVATE_KEY",
  "KALSHI_DEMO_PRIVATE_KEY_PATH",
  "KALSHI_PROD_PRIVATE_KEY_PATH",
  "MM_FORCE_DEMO_GUARD",
];

let saved;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveKalshiRunMode", () => {
  it("defaults to demo when MM_RUN_MODE unset", () => {
    assert.equal(resolveKalshiRunMode(), "demo");
  });
  it("returns 'prod' when MM_RUN_MODE=prod", () => {
    process.env.MM_RUN_MODE = "prod";
    assert.equal(resolveKalshiRunMode(), "prod");
  });
  it("treats unknown values as demo", () => {
    process.env.MM_RUN_MODE = "staging";
    assert.equal(resolveKalshiRunMode(), "demo");
  });
  it("override beats env", () => {
    process.env.MM_RUN_MODE = "prod";
    assert.equal(resolveKalshiRunMode("demo"), "demo");
  });
});

describe("deriveWsUrlFromRest", () => {
  it("derives demo WS from demo REST base", () => {
    assert.equal(
      deriveWsUrlFromRest("https://demo-api.kalshi.co/trade-api/v2", "demo"),
      "wss://demo-api.kalshi.co/trade-api/ws/v2",
    );
  });
  it("derives prod WS from prod REST base", () => {
    assert.equal(
      deriveWsUrlFromRest("https://api.elections.kalshi.com/trade-api/v2", "prod"),
      "wss://api.elections.kalshi.com/trade-api/ws/v2",
    );
  });
  it("returns prod default if rest base mismatches mode (mode=prod, host=demo)", () => {
    assert.equal(
      deriveWsUrlFromRest("https://demo-api.kalshi.co/trade-api/v2", "prod"),
      "wss://api.elections.kalshi.com/trade-api/ws/v2",
    );
  });
  it("returns demo default if mode=demo and host is unrelated", () => {
    assert.equal(
      deriveWsUrlFromRest("https://api.elections.kalshi.com/trade-api/v2", "demo"),
      "wss://demo-api.kalshi.co/trade-api/ws/v2",
    );
  });
  it("falls back on bad URL", () => {
    assert.equal(deriveWsUrlFromRest("not-a-url", "demo"), "wss://demo-api.kalshi.co/trade-api/ws/v2");
    assert.equal(deriveWsUrlFromRest("not-a-url", "prod"), "wss://api.elections.kalshi.com/trade-api/ws/v2");
  });
});

describe("kalshiEnvFromMode — DEMO", () => {
  it("returns demo defaults with no env set", () => {
    const env = kalshiEnvFromMode();
    assert.equal(env.runMode, "demo");
    assert.equal(env.restBase, "https://demo-api.kalshi.co/trade-api/v2");
    assert.equal(env.wsUrl, "wss://demo-api.kalshi.co/trade-api/ws/v2");
    assert.equal(env.apiKeyId, undefined);
  });
  it("respects KALSHI_BASE override in demo", () => {
    process.env.KALSHI_BASE = "https://demo-api.kalshi.co/trade-api/v2";
    const env = kalshiEnvFromMode();
    assert.equal(env.restBase, "https://demo-api.kalshi.co/trade-api/v2");
  });
  it("reads KALSHI_DEMO_API_KEY_ID + KALSHI_DEMO_PRIVATE_KEY in demo mode", () => {
    process.env.KALSHI_DEMO_API_KEY_ID = "demo-id";
    process.env.KALSHI_DEMO_PRIVATE_KEY = "demo-pem";
    const env = kalshiEnvFromMode();
    assert.equal(env.apiKeyId, "demo-id");
    assert.equal(env.privateKeyInline, "demo-pem");
  });
  it("does NOT read KALSHI_PROD_* secrets in demo mode", () => {
    process.env.KALSHI_PROD_API_KEY_ID = "prod-id";
    process.env.KALSHI_PROD_PRIVATE_KEY = "prod-pem";
    const env = kalshiEnvFromMode();
    assert.equal(env.runMode, "demo");
    assert.equal(env.apiKeyId, undefined);
    assert.equal(env.privateKeyInline, undefined);
  });
});

describe("kalshiEnvFromMode — PROD", () => {
  beforeEach(() => {
    process.env.MM_RUN_MODE = "prod";
  });

  it("returns prod defaults", () => {
    const env = kalshiEnvFromMode();
    assert.equal(env.runMode, "prod");
    assert.equal(env.restBase, "https://api.elections.kalshi.com/trade-api/v2");
    assert.equal(env.wsUrl, "wss://api.elections.kalshi.com/trade-api/ws/v2");
  });
  it("reads KALSHI_PROD_API_KEY_ID + KALSHI_PROD_PRIVATE_KEY in prod mode", () => {
    process.env.KALSHI_PROD_API_KEY_ID = "prod-id";
    process.env.KALSHI_PROD_PRIVATE_KEY = "prod-pem";
    const env = kalshiEnvFromMode();
    assert.equal(env.apiKeyId, "prod-id");
    assert.equal(env.privateKeyInline, "prod-pem");
  });
  it("does NOT read KALSHI_DEMO_* secrets in prod mode", () => {
    process.env.KALSHI_DEMO_API_KEY_ID = "demo-id";
    process.env.KALSHI_DEMO_PRIVATE_KEY = "demo-pem";
    const env = kalshiEnvFromMode();
    assert.equal(env.apiKeyId, undefined);
    assert.equal(env.privateKeyInline, undefined);
  });
  it("respects KALSHI_PROD_REST_BASE / KALSHI_PROD_WS_URL overrides", () => {
    process.env.KALSHI_PROD_REST_BASE = "https://api.elections.kalshi.com/trade-api/v2";
    process.env.KALSHI_PROD_WS_URL = "wss://override.example/ws";
    const env = kalshiEnvFromMode();
    assert.equal(env.wsUrl, "wss://override.example/ws");
  });
  it("override beats env", () => {
    process.env.MM_RUN_MODE = "demo";
    const env = kalshiEnvFromMode("prod");
    assert.equal(env.runMode, "prod");
    assert.equal(env.restBase, "https://api.elections.kalshi.com/trade-api/v2");
  });
});

describe("guardKalshiTradingBase", () => {
  it("does not throw on matching demo host", () => {
    guardKalshiTradingBase("https://demo-api.kalshi.co/trade-api/v2", "demo");
  });
  it("does not throw on matching prod host", () => {
    guardKalshiTradingBase("https://api.elections.kalshi.com/trade-api/v2", "prod");
  });
  it("does not throw on mismatched host (only warns)", () => {
    // Capture warn so it doesn't pollute test output
    const orig = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      guardKalshiTradingBase("https://demo-api.kalshi.co/trade-api/v2", "prod");
    } finally {
      console.warn = orig;
    }
    assert.equal(warned, true);
  });
  it("silenced by MM_FORCE_DEMO_GUARD=0", () => {
    process.env.MM_FORCE_DEMO_GUARD = "0";
    const orig = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      guardKalshiTradingBase("https://demo-api.kalshi.co/trade-api/v2", "prod");
    } finally {
      console.warn = orig;
    }
    assert.equal(warned, false);
  });
});
