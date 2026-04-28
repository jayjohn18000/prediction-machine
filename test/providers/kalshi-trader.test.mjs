import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  KalshiTrader,
  replaceQuoteR11,
  signPathFromBase,
} from "../../lib/providers/kalshi-trader.mjs";

/** Generate valid PEM using minimal keyGen - PKCS8 */
function ephemeralRsa() {
  return crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
}

test("signPathFromBase joins hostname path for signing", () => {
  const p = signPathFromBase("https://demo-api.kalshi.co/trade-api/v2", "/portfolio/orders");
  assert.equal(p, "/trade-api/v2/portfolio/orders");
});

test("buildCreateOrderBody maps MM sides to Kalshi openapi", async () => {
  const kp = ephemeralRsa();
  const trader = new KalshiTrader({
    baseTradeUrl: "https://demo-api.kalshi.co/trade-api/v2",
    privateKey: kp.privateKey,
    keyId: "test-key",
    fetchFn: async () => new Response("{}", { status: 500 }),
  });
  const b1 = trader.buildCreateOrderBody({
    ticker: "T",
    mmSide: "yes_buy",
    priceCents: 45,
    sizeContracts: 2,
    clientOrderId: "cid",
  });
  assert.deepEqual(b1.side, "yes");
  assert.deepEqual(b1.action, "buy");
  assert.equal(b1.yes_price, 45);
  const b2 = trader.buildCreateOrderBody({
    ticker: "T",
    mmSide: "no_buy",
    priceCents: 40,
    sizeContracts: 1,
    clientOrderId: "cid2",
  });
  assert.equal(b2.side, "no");
  assert.equal(b2.no_price, 40);
});

test("replaceQuoteR11 does not await cancel before place", async () => {
  const seq = [];
  const deps = {
    cancelOrder: async (id) => {
      seq.push("cancel_start");
      await new Promise((r) => setTimeout(r, 30));
      seq.push(`cancel_done:${id}`);
    },
    placeOrder: async (p) => {
      seq.push("place_done");
      return { ok: true, p };
    },
  };
  const p = replaceQuoteR11(deps, { restingKalshiOrderId: "ord1", placePayload: { x: 1 } });
  assert.deepEqual(seq.slice(0, 2), ["cancel_start", "place_done"]);
  await p;
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(seq, ["cancel_start", "place_done", "cancel_done:ord1"]);
});

test("KalshiTrader.request attaches auth headers (mock)", async () => {
  const kp = ephemeralRsa();
  /** @type {RequestInit | undefined} */
  let last;
  const fetchFn = async (url, init) => {
    last = init;
    return new Response(JSON.stringify({ fills: [], cursor: "" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const trader = new KalshiTrader({
    baseTradeUrl: "https://demo-api.kalshi.co/trade-api/v2",
    privateKey: kp.privateKey,
    keyId: "kid-demo",
    fetchFn,
  });
  await trader.getFills({ limit: 5 });
  assert.ok(last?.headers);
  const h = last.headers;
  const key =
    typeof h.get === "function" ? h.get("KALSHI-ACCESS-KEY") : /** @type {Record<string,string>} */ (h)["KALSHI-ACCESS-KEY"];
  assert.ok(typeof key === "string" && key.length > 0);
});
