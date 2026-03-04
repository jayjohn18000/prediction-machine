/**
 * pmci-client.mjs — Zero-dependency PMCI API client.
 *
 * Usage:
 *   import { PmciClient, PmciError } from "./lib/pmci-client.mjs";
 *
 *   const client = new PmciClient({
 *     baseUrl: process.env.PMCI_BASE_URL ?? "http://localhost:8787",
 *     apiKey:  process.env.PMCI_API_KEY,
 *     adminKey: process.env.PMCI_ADMIN_KEY,
 *   });
 *
 *   const freshness = await client.getHealthFreshness();
 *
 * Rate-limit (429) responses are automatically retried up to 3 times with
 * full-jitter exponential backoff (base 1000ms, factor 2). All other non-2xx
 * responses throw a PmciError immediately.
 */

import { retry, fetchWithTimeout } from "./retry.mjs";

// ── Error class ────────────────────────────────────────────────────────────

export class PmciError extends Error {
  /**
   * @param {string} message
   * @param {{ status: number, body: unknown, headers: Headers }} opts
   */
  constructor(message, { status, body, headers }) {
    super(message);
    this.name = "PmciError";
    this.status = status;
    this.body = body;
    this.headers = headers;
  }

  get isStale() {
    return this.status === 503;
  }

  get isRateLimited() {
    return this.status === 429;
  }

  get isUnauthorized() {
    return this.status === 401;
  }
}

// ── Client ─────────────────────────────────────────────────────────────────

export class PmciClient {
  /**
   * @param {object} opts
   * @param {string}  [opts.baseUrl="http://localhost:8787"]
   * @param {string}  [opts.apiKey]   - sent as x-pmci-api-key on non-health routes
   * @param {string}  [opts.adminKey] - sent as x-pmci-admin-key on /v1/resolve/link
   * @param {number}  [opts.timeoutMs=15000]
   */
  constructor({ baseUrl = "http://localhost:8787", apiKey, adminKey, timeoutMs = 15_000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.adminKey = adminKey;
    this.timeoutMs = timeoutMs;
  }

  // ── Health (public) ──────────────────────────────────────────────────────

  /** @returns {Promise<import("./pmci-client.types.d.ts").FreshnessResponse>} */
  getHealthFreshness() {
    return this._request("GET", "/v1/health/freshness");
  }

  /** @returns {Promise<import("./pmci-client.types.d.ts").SloResponse>} */
  getHealthSlo() {
    return this._request("GET", "/v1/health/slo");
  }

  /** @returns {Promise<import("./pmci-client.types.d.ts").ProjectionReadyResponse>} */
  getHealthProjectionReady() {
    return this._request("GET", "/v1/health/projection-ready");
  }

  /** @returns {Promise<import("./pmci-client.types.d.ts").ObserverHealthResponse>} */
  getHealthObserver() {
    return this._request("GET", "/v1/health/observer");
  }

  /** @returns {Promise<import("./pmci-client.types.d.ts").UsageResponse>} */
  getHealthUsage() {
    return this._request("GET", "/v1/health/usage");
  }

  // ── Providers & Coverage ─────────────────────────────────────────────────

  /** @returns {Promise<Array<{code: string, name: string}>>} */
  getProviders() {
    return this._request("GET", "/v1/providers");
  }

  /**
   * @param {{ provider: string, category?: string }} params
   * @returns {Promise<import("./pmci-client.types.d.ts").CoverageResponse>}
   */
  getCoverage({ provider, category } = {}) {
    return this._request("GET", "/v1/coverage", { query: { provider, category } });
  }

  /**
   * @param {{ provider: string, category?: string, since?: string }} params
   * @returns {Promise<import("./pmci-client.types.d.ts").CoverageSummaryResponse>}
   */
  getCoverageSummary({ provider, category, since } = {}) {
    return this._request("GET", "/v1/coverage/summary", { query: { provider, category, since } });
  }

  // ── Markets ──────────────────────────────────────────────────────────────

  /**
   * @param {{ provider: string, category?: string, since?: string, limit?: number }} params
   * @returns {Promise<Array<import("./pmci-client.types.d.ts").MarketObject>>}
   */
  getMarketsUnlinked({ provider, category, since, limit } = {}) {
    return this._request("GET", "/v1/markets/unlinked", { query: { provider, category, since, limit } });
  }

  /**
   * @param {{ provider: string, since: string, category?: string, limit?: number }} params
   * @returns {Promise<Array<import("./pmci-client.types.d.ts").MarketObject>>}
   */
  getMarketsNew({ provider, since, category, limit } = {}) {
    return this._request("GET", "/v1/markets/new", { query: { provider, since, category, limit } });
  }

  // ── Families & Links ─────────────────────────────────────────────────────

  /**
   * @param {{ event_id: string }} params
   * @returns {Promise<Array<import("./pmci-client.types.d.ts").MarketFamily>>}
   */
  getMarketFamilies({ event_id } = {}) {
    return this._request("GET", "/v1/market-families", { query: { event_id } });
  }

  /**
   * @param {{ family_id: number }} params
   * @returns {Promise<Array<import("./pmci-client.types.d.ts").MarketLink>>}
   */
  getMarketLinks({ family_id } = {}) {
    return this._request("GET", "/v1/market-links", { query: { family_id } });
  }

  // ── Signals ──────────────────────────────────────────────────────────────

  /**
   * Returns per-link divergence for a family. Throws PmciError with isStale=true if observer is down.
   * @param {{ family_id: number }} params
   * @returns {Promise<Array<import("./pmci-client.types.d.ts").DivergenceSignal>>}
   */
  getDivergence({ family_id } = {}) {
    return this._request("GET", "/v1/signals/divergence", { query: { family_id } });
  }

  /**
   * Returns top divergences across an event. Throws PmciError with isStale=true if observer is down.
   * @param {{ event_id: string, limit?: number }} params
   * @returns {Promise<Array<import("./pmci-client.types.d.ts").TopDivergenceResult>>}
   */
  getTopDivergences({ event_id, limit } = {}) {
    return this._request("GET", "/v1/signals/top-divergences", { query: { event_id, limit } });
  }

  // ── Review ────────────────────────────────────────────────────────────────

  /**
   * @param {{ category?: string, limit?: number, min_confidence?: number }} params
   * @returns {Promise<Array<import("./pmci-client.types.d.ts").ReviewQueueItem>>}
   */
  getReviewQueue({ category, limit, min_confidence } = {}) {
    return this._request("GET", "/v1/review/queue", { query: { category, limit, min_confidence } });
  }

  /**
   * @param {{ proposed_id: number, decision: "accept"|"reject"|"skip", relationship_type: "equivalent"|"proxy", note?: string }} params
   * @returns {Promise<import("./pmci-client.types.d.ts").ReviewDecisionResponse>}
   */
  postReviewDecision({ proposed_id, decision, relationship_type, note } = {}) {
    return this._request("POST", "/v1/review/decision", {
      body: { proposed_id, decision, relationship_type, note },
    });
  }

  // ── Admin ─────────────────────────────────────────────────────────────────

  /**
   * Directly inserts an active link. Requires adminKey to be set on the client.
   * @param {{ family_id: number, provider_code: string, provider_market_id: number, relationship_type: string, confidence: number, reasons: object, correlation_window?: string, lag_seconds?: number, correlation_strength?: number }} params
   * @returns {Promise<{link_id: number, link_version: number, status: string}>}
   */
  resolveLink({
    family_id,
    provider_code,
    provider_market_id,
    relationship_type,
    confidence,
    reasons = {},
    correlation_window,
    lag_seconds,
    correlation_strength,
  } = {}) {
    return this._request("POST", "/v1/resolve/link", {
      body: {
        family_id,
        provider_code,
        provider_market_id,
        relationship_type,
        confidence,
        reasons,
        correlation_window,
        lag_seconds,
        correlation_strength,
      },
      admin: true,
    });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Core request helper. Handles auth headers, query string building,
   * JSON serialization, and rate-limit retry.
   *
   * @param {"GET"|"POST"} method
   * @param {string} path - must start with "/"
   * @param {{ query?: object, body?: object, admin?: boolean }} [opts]
   * @returns {Promise<any>}
   */
  async _request(method, path, { query, body, admin = false } = {}) {
    const url = new URL(this.baseUrl + path);

    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v != null) url.searchParams.set(k, String(v));
      }
    }

    const headers = { "Content-Type": "application/json" };

    // Health routes are always public — never send auth headers there
    const isHealth = path.startsWith("/v1/health/");
    if (!isHealth && this.apiKey) {
      headers["x-pmci-api-key"] = this.apiKey;
    }
    if (admin && this.adminKey) {
      headers["x-pmci-admin-key"] = this.adminKey;
    }

    const fetchOpts = {
      method,
      headers,
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    };

    return retry(
      async () => {
        const res = await fetchWithTimeout(url.toString(), fetchOpts, this.timeoutMs);

        if (!res.ok) {
          let errBody;
          try {
            errBody = await res.json();
          } catch {
            errBody = null;
          }
          const err = new PmciError(`HTTP ${res.status} ${res.statusText}`, {
            status: res.status,
            body: errBody,
            headers: res.headers,
          });
          throw err;
        }

        return res.json();
      },
      {
        maxAttempts: 4, // 1 initial + 3 retries
        baseDelayMs: 1_000,
        factor: 2,
        jitter: true,
        isRetriable: (err) => err instanceof PmciError && err.isRateLimited,
      },
    );
  }
}
