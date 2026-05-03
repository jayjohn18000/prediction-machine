#!/usr/bin/env node
/**
 * Kalshi DEMO-only round-trip: list one open market → place min-size limit → get order → cancel.
 * Env: KALSHI_DEMO_API_KEY_ID, KALSHI_DEMO_PRIVATE_KEY_PATH or KALSHI_DEMO_PRIVATE_KEY
 *      KALSHI_DEMO_REST_BASE (defaults to https://demo-api.kalshi.co/trade-api/v2 — must stay on demo hostname).
 */

import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

import { loadPrivateKey } from "../../lib/providers/kalshi-ws-auth.mjs";
import { KalshiTrader } from "../../lib/providers/kalshi-trader.mjs";
import { nextClientOrderId } from "../../lib/mm/client-order-id.mjs";

function assertDemoBase(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Invalid KALSHI_DEMO_REST_BASE");
  }
  if (u.hostname !== "demo-api.kalshi.co") {
    throw new Error(`Refusing non-demo Kalshi REST base (${u.hostname}); production endpoints are blocked for this script.`);
  }
}

async function main() {
  const baseTradeUrl =
    process.env.KALSHI_DEMO_REST_BASE?.trim() || "https://demo-api.kalshi.co/trade-api/v2";

  assertDemoBase(baseTradeUrl);

  const keyId = process.env.KALSHI_DEMO_API_KEY_ID?.trim();
  const privateKey = loadPrivateKey({
    path: process.env.KALSHI_DEMO_PRIVATE_KEY_PATH,
    inline: process.env.KALSHI_DEMO_PRIVATE_KEY,
  });

  if (!keyId) {
    console.error("Missing KALSHI_DEMO_API_KEY_ID.");
    process.exit(1);
  }

  console.log("[mm:dev] Using REST base:", baseTradeUrl);

  const trader = new KalshiTrader({ baseTradeUrl, privateKey, keyId });

  /** Public read — no RSA */
  const listUrl = `${baseTradeUrl}/markets?limit=80&status=open`;
  const listRes = await fetch(listUrl);
  const listBody = await listRes.json().catch(() => ({}));
  if (!listRes.ok) {
    console.error("Failed listing open markets:", listRes.status, listBody);
    process.exit(1);
  }
  const candidates = listBody.markets ?? [];
  const simple =
    candidates.find((m) => {
      const s = `${m?.ticker ?? ""} ${m?.title ?? ""}`;
      return m?.ticker && !/\bKXMV|MVECROSS|MULTIV|ECLIPSE|ECLP|VANNA\b/i.test(s);
    }) ?? candidates[0];
  if (!simple?.ticker) {
    console.error("No open demo market returned.", listBody);
    process.exit(1);
  }

  const ticker = simple.ticker;
  const detRes = await fetch(`${baseTradeUrl}/markets/${encodeURIComponent(ticker)}`);
  const det = await detRes.json().catch(() => ({}));
  const mk = det.market ?? det;
  function usd(v) {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  const bidC =
    mk.yes_bid_dollars != null
      ? Math.round(Number(mk.yes_bid_dollars) * 100)
      : mk.yes_bid != null
        ? Number(mk.yes_bid)
        : null;
  const askC =
    mk.yes_ask_dollars != null
      ? Math.round(Number(mk.yes_ask_dollars) * 100)
      : mk.yes_ask != null
        ? Number(mk.yes_ask)
        : null;
  let priceCents = 50;
  if (bidC != null && askC != null && askC > bidC + 1) priceCents = Math.floor((bidC + askC) / 2);
  else if (bidC != null) priceCents = Math.min(97, bidC + 1);
  else if (usd(mk.last_price_dollars) != null) priceCents = Math.round(usd(mk.last_price_dollars) * 100);
  priceCents = Math.min(97, Math.max(2, priceCents));

  const client_order_id = nextClientOrderId({ ticker, side: "yes_buy" });

  const placeBody = trader.buildCreateOrderBody({
    ticker,
    mmSide: "yes_buy",
    priceCents,
    sizeContracts: 1,
    clientOrderId: client_order_id,
    postOnly: true,
    priceLevelStructure: mk.price_level_structure != null ? String(mk.price_level_structure) : null,
  });

  console.log("[mm:dev] Placing...", { ticker, client_order_id, placeBody });

  const created = await trader.createOrder(placeBody);
  const order = created?.order;
  const oid = order?.order_id ?? order?.OrderID;
  console.log("[mm:dev] Create response order_id=", oid, "status=", order?.status);

  if (!oid) {
    console.error("Unexpected create payload:", JSON.stringify(created));
    process.exit(1);
  }

  const got = await trader.getOrder(oid);
  console.log("[mm:dev] GET order status=", got?.order?.status);

  const cancelled = await trader.cancelOrder(oid);
  console.log("[mm:dev] Cancel response:", JSON.stringify(cancelled)?.slice(0, 500));

  const fills = await trader.getFills({ limit: 5, ticker });
  console.log("[mm:dev] Recent fills sample (limit 5):", JSON.stringify(fills)?.slice(0, 800));

  console.log("[mm:dev] DEMO round-trip OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
