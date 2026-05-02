/**
 * Kalshi environment resolver — single source of truth for DEMO vs PROD switching.
 *
 * `MM_RUN_MODE=prod` selects production Kalshi (`api.elections.kalshi.com`) and
 * reads `KALSHI_PROD_*` secrets. Anything else (default `demo`) selects DEMO
 * (`demo-api.kalshi.co`) and reads `KALSHI_DEMO_*` secrets.
 *
 * Per ADR-011 (live cutover spec) + ADR-012 (fresh PROD clock).
 *
 * The trader, depth ingestor, and orchestrator REST snapshot path all funnel
 * through this so the only env switch the operator flips is `MM_RUN_MODE`.
 */
import "dotenv/config";

/** @typedef {'demo' | 'prod'} KalshiRunMode */

/**
 * Resolve the active Kalshi run mode. Default: 'demo'.
 *
 * @param {string} [override]
 * @returns {KalshiRunMode}
 */
export function resolveKalshiRunMode(override) {
  const raw = (override ?? process.env.MM_RUN_MODE ?? "demo").trim().toLowerCase();
  return raw === "prod" ? "prod" : "demo";
}

const DEMO_REST_DEFAULT = "https://demo-api.kalshi.co/trade-api/v2";
const DEMO_WS_DEFAULT = "wss://demo-api.kalshi.co/trade-api/ws/v2";
const PROD_REST_DEFAULT = "https://api.elections.kalshi.com/trade-api/v2";
const PROD_WS_DEFAULT = "wss://api.elections.kalshi.com/trade-api/ws/v2";

/**
 * Derive the WS URL from a REST base. Pure function; tested.
 *
 * @param {string} restBase
 * @param {KalshiRunMode} runMode
 * @returns {string}
 */
export function deriveWsUrlFromRest(restBase, runMode) {
  try {
    const u = new URL(restBase);
    const expectedHost = runMode === "prod" ? /(^|\.)kalshi\.com$/i : /demo-api\.kalshi\.co$/i;
    if (!expectedHost.test(u.hostname)) {
      // Mismatch between explicit REST host and run mode — return the mode default.
      return runMode === "prod" ? PROD_WS_DEFAULT : DEMO_WS_DEFAULT;
    }
    u.protocol = "wss:";
    const p = u.pathname.replace(/\/$/, "");
    u.pathname = p.endsWith("/trade-api/v2") ? p.replace(/\/v2$/, "/ws/v2") : "/trade-api/ws/v2";
    return u.href.replace(/\/$/, "");
  } catch {
    return runMode === "prod" ? PROD_WS_DEFAULT : DEMO_WS_DEFAULT;
  }
}

/**
 * @typedef {object} KalshiEnv
 * @property {KalshiRunMode} runMode
 * @property {string} restBase     — full REST base ending in /trade-api/v2 (no trailing slash)
 * @property {string} wsUrl        — full WS URL ending in /trade-api/ws/v2
 * @property {string|undefined} apiKeyId
 * @property {string|undefined} privateKeyInline   — PEM contents (preferred; Fly secret form)
 * @property {string|undefined} privateKeyPath     — filesystem path to PEM (legacy form)
 */

/**
 * Resolve the full Kalshi env tuple based on the active run mode.
 *
 * Lookup precedence:
 *   PROD: KALSHI_PROD_REST_BASE → default; KALSHI_PROD_WS_URL → derived; KALSHI_PROD_API_KEY_ID; KALSHI_PROD_PRIVATE_KEY (inline) | KALSHI_PROD_PRIVATE_KEY_PATH
 *   DEMO: KALSHI_BASE | KALSHI_DEMO_REST_BASE → default; KALSHI_WS_URL | KALSHI_DEMO_WS_URL → derived; KALSHI_DEMO_API_KEY_ID | KALSHI_API_KEY_ID; KALSHI_DEMO_PRIVATE_KEY | KALSHI_DEMO_PRIVATE_KEY_PATH
 *
 * @param {string} [modeOverride]
 * @returns {KalshiEnv}
 */
export function kalshiEnvFromMode(modeOverride) {
  const runMode = resolveKalshiRunMode(modeOverride);

  if (runMode === "prod") {
    const restBase =
      process.env.KALSHI_PROD_REST_BASE?.trim() || PROD_REST_DEFAULT;
    const wsUrl =
      process.env.KALSHI_PROD_WS_URL?.trim() ||
      deriveWsUrlFromRest(restBase, "prod");
    return {
      runMode: "prod",
      restBase,
      wsUrl,
      apiKeyId: process.env.KALSHI_PROD_API_KEY_ID?.trim() || undefined,
      privateKeyInline: process.env.KALSHI_PROD_PRIVATE_KEY || undefined,
      privateKeyPath: process.env.KALSHI_PROD_PRIVATE_KEY_PATH?.trim() || undefined,
    };
  }

  const restBase =
    process.env.KALSHI_BASE?.trim() ||
    process.env.KALSHI_DEMO_REST_BASE?.trim() ||
    DEMO_REST_DEFAULT;
  const wsUrl =
    process.env.KALSHI_WS_URL?.trim() ||
    process.env.KALSHI_DEMO_WS_URL?.trim() ||
    deriveWsUrlFromRest(restBase, "demo");

  return {
    runMode: "demo",
    restBase,
    wsUrl,
    apiKeyId:
      process.env.KALSHI_DEMO_API_KEY_ID?.trim() ||
      process.env.KALSHI_API_KEY_ID?.trim() ||
      undefined,
    privateKeyInline: process.env.KALSHI_DEMO_PRIVATE_KEY || undefined,
    privateKeyPath: process.env.KALSHI_DEMO_PRIVATE_KEY_PATH?.trim() || undefined,
  };
}

/**
 * Soft-warn when the resolved REST base doesn't match the expected env-mode host.
 * Replaces the legacy `guardDemoTradingBase`. Set `MM_FORCE_DEMO_GUARD=0` to silence.
 *
 * @param {string} baseUrl
 * @param {KalshiRunMode} runMode
 */
export function guardKalshiTradingBase(baseUrl, runMode) {
  if (process.env.MM_FORCE_DEMO_GUARD === "0") return;
  try {
    const u = new URL(baseUrl);
    const expected = runMode === "prod" ? /(^|\.)kalshi\.com$/i : /demo-api\.kalshi\.co$/i;
    if (!expected.test(u.hostname)) {
      console.warn(
        `[mm] WARN: orchestrator REST base ${u.hostname} does not match MM_RUN_MODE=${runMode}`,
      );
    }
  } catch {
    /* ignore */
  }
}
