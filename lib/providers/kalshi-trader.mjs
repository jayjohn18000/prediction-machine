/**
 * Kalshi authenticated trading REST client (portfolio orders, fills).
 * RSA signing reuses ./kalshi-ws-auth.mjs (same scheme as authenticated_requests quick start).
 */

import { signRequest } from "./kalshi-ws-auth.mjs";

export { loadPrivateKey, signRequest } from "./kalshi-ws-auth.mjs";

/**
 * @param {string} baseTradeUrl e.g. https://demo-api.kalshi.co/trade-api/v2 (no trailing path beyond v2).
 * @param {string} pathSuffix e.g. /portfolio/orders
 */
export function signPathFromBase(baseTradeUrl, pathSuffix) {
  const pathOnly = pathSuffix.split("?")[0];
  const rel = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
  const base = new URL(baseTradeUrl.endsWith("/") ? baseTradeUrl : `${baseTradeUrl}/`);
  const joined = `${base.pathname.replace(/\/$/, "")}${rel}`;
  return joined.split("?")[0];
}

/**
 * @typedef {import('node:crypto').KeyObject} KeyObject
 */

/**
 * Signed Kalshi Portfolio API client.
 */
export class KalshiTrader {
  /**
   * @param {{ baseTradeUrl: string, privateKey: KeyObject, keyId: string, fetchFn?: typeof fetch }} opts
   */
  constructor(opts) {
    if (!opts?.baseTradeUrl?.trim()) throw new Error("KalshiTrader: baseTradeUrl required");
    if (!opts?.privateKey) throw new Error("KalshiTrader: privateKey required");
    if (!opts?.keyId?.trim()) throw new Error("KalshiTrader: keyId required");
    this.baseTradeUrl = opts.baseTradeUrl.replace(/\/$/, "");
    this.privateKey = opts.privateKey;
    this.keyId = opts.keyId;
    /** @private */
    this._fetch = opts.fetchFn ?? globalThis.fetch?.bind(globalThis);
    if (typeof this._fetch !== "function") throw new Error("KalshiTrader: fetch is not available");
  }

  /**
   * Signed headers for Kalshi Portfolio API — path must omit query strings (authenticated_requests doc).
   * @param {'GET'|'POST'|'DELETE'} method
   * @param {string} signPath full pathname e.g. /trade-api/v2/portfolio/orders
   * @param {string} bodyStr must match outbound body byte-for-byte for POST
   */
  authHeaders(method, signPath, bodyStr = "") {
    const ts = Date.now();
    const { timestamp, signatureBase64 } = signRequest({
      privateKey: this.privateKey,
      method,
      path: signPath.split("?")[0],
      timestampMs: ts,
    });
    /** @type {Record<string,string>} */
    const h = {
      "KALSHI-ACCESS-KEY": this.keyId,
      "KALSHI-ACCESS-SIGNATURE": signatureBase64,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
    };
    if (bodyStr !== "") {
      h["Content-Type"] = "application/json";
    }
    return h;
  }

  /**
   * @param {'GET'|'POST'|'DELETE'} method
   * @param {string} pathSuffix absolute path segment after …/trade-api/v2 — e.g. /portfolio/fills?ticker=X
   * @param {object|string|undefined} bodyObjOrStr POST/PUT JSON object (stringified verbatim)
   */
  async request(method, pathSuffix, bodyObjOrStr = undefined) {
    const rel = pathSuffix.startsWith("/") ? pathSuffix : `/${pathSuffix}`;
    const url = `${this.baseTradeUrl}${rel}`;
    const pathOnly = rel.split("?")[0];
    const signPath = signPathFromBase(this.baseTradeUrl, pathOnly);
    const bodyStr =
      method !== "GET" && method !== "DELETE" && bodyObjOrStr !== undefined
        ? typeof bodyObjOrStr === "string"
          ? bodyObjOrStr
          : JSON.stringify(bodyObjOrStr)
        : "";
    const headers = this.authHeaders(method, signPath, bodyStr);
    const res = await this._fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "DELETE" ? undefined : bodyStr,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`Kalshi ${method} ${pathSuffix}: HTTP ${res.status}`);
      /** @type {any} */
      err.status = res.status;
      /** @type {any} */
      err.body = json;
      throw err;
    }
    return json;
  }

  /**
   * @param {object} input Kalshi REST body (openapi CreateOrderRequest + type/time_in_force)
   */
  createOrder(input) {
    return this.request("POST", "/portfolio/orders", input);
  }

  /**
   * Normalize MM side + cents into Kalshi REST create-order body.
   * @param {object} p
   * @param {string} p.ticker
   * @param {'yes_buy'|'yes_sell'|'no_buy'|'no_sell'} p.mmSide
   * @param {number} p.priceCents limit price in cents on the quoted leg (1–99)
   * @param {number} p.sizeContracts
   * @param {string} p.clientOrderId Contract R9
   * @param {boolean} [p.postOnly] maker-only (post_only on wire)
   */
  buildCreateOrderBody({ ticker, mmSide, priceCents, sizeContracts, clientOrderId, postOnly }) {
    const pc = Number(priceCents);
    if (!Number.isFinite(pc) || pc < 1 || pc > 99) throw new Error("KalshiTrader: priceCents must be 1–99");

    /** @type {Record<string, unknown>} */
    const body = {
      ticker,
      client_order_id: clientOrderId,
      type: "limit",
      count: Number(sizeContracts),
      time_in_force: "good_till_canceled",
      ...(postOnly === true ? { post_only: true } : {}),
    };

    if (mmSide === "yes_buy" || mmSide === "yes_sell") {
      body.side = "yes";
      body.action = mmSide === "yes_buy" ? "buy" : "sell";
      body.yes_price = Math.round(pc);
    } else {
      body.side = "no";
      body.action = mmSide === "no_buy" ? "buy" : "sell";
      body.no_price = Math.round(pc);
    }
    return body;
  }

  /**
   * @param {{ ticker: string, mmSide: string, priceCents: number, sizeContracts: number, clientOrderId: string }} p
   */
  async createOrderFromMM(p) {
    return this.createOrder(this.buildCreateOrderBody(p));
  }

  /**
   * @param {string} kalshiOrderId
   */
  async cancelOrder(kalshiOrderId) {
    const path = `/portfolio/orders/${encodeURIComponent(kalshiOrderId)}`;
    return this.request("DELETE", path);
  }

  /**
   * @param {string} kalshiOrderId
   */
  async getOrder(kalshiOrderId) {
    const path = `/portfolio/orders/${encodeURIComponent(kalshiOrderId)}`;
    return this.request("GET", path);
  }

  /**
   * @param {Record<string, string|number|boolean>|undefined} query
   */
  async getOrders(query = undefined) {
    const q = query ? new URLSearchParams(/** @type {any} */ (query)).toString() : "";
    const path = q ? `/portfolio/orders?${q}` : "/portfolio/orders";
    return this.request("GET", path);
  }

  /**
   * @param {Record<string, string|number|boolean>|undefined} query
   */
  async getFills(query = undefined) {
    const q = query ? new URLSearchParams(/** @type {any} */ (query)).toString() : "";
    const path = q ? `/portfolio/fills?${q}` : "/portfolio/fills";
    return this.request("GET", path);
  }

  /**
   * R11: fire-and-forget cancel (no await) then place replacement.
   * @param {{ restingKalshiOrderId: string, place: Parameters<KalshiTrader['createOrderFromMM']>[0] }} p
   */
  async replaceQuote({ restingKalshiOrderId, place }) {
    void this.cancelOrder(restingKalshiOrderId).catch(() => {});
    return this.createOrderFromMM(place);
  }
}

/**
 * R11 pure hook for tests — same sequencing with injectable deps.
 * @param {{ cancelOrder: (id: string) => Promise<unknown>, placeOrder: (p: object) => Promise<unknown> }} deps
 * @param {{ restingKalshiOrderId: string, placePayload: object }} p
 */
export async function replaceQuoteR11(deps, { restingKalshiOrderId, placePayload }) {
  void deps.cancelOrder(restingKalshiOrderId).catch(() => {});
  return deps.placeOrder(placePayload);
}
