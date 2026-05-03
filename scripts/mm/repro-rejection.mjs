#!/usr/bin/env node
/**
 * One-shot Kalshi placement probe for diagnosing HTTP 400 rejection storms on
 * scalar / subpenny / fractional markets (e.g. KXLCPIMAXYOY-27-P4.5, deci_cent).
 *
 * Reads public market metadata, logs price_level_structure + fractional_trading_enabled,
 * POSTs a single post_only limit (far from book by default) and prints the full
 * error body on failure.
 *
 * Env (via MM_RUN_MODE): PROD uses KALSHI_PROD_* ; DEMO uses KALSHI_DEMO_*.
 *
 * Usage:
 *   node scripts/mm/repro-rejection.mjs [TICKER]
 *   MM_DRY_RUN=1 node scripts/mm/repro-rejection.mjs   # print body only, no POST
 */

import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

import { KalshiTrader, loadPrivateKey } from "../../lib/providers/kalshi-trader.mjs";
import { kalshiEnvFromMode } from "../../lib/mm/kalshi-env.mjs";

const ticker = process.argv[2] ?? "KXLCPIMAXYOY-27-P4.5";
const dry = process.env.MM_DRY_RUN === "1" || process.env.MM_DRY_RUN === "true";

async function fetchPublicMarket(restBase, t) {
  const base = restBase.replace(/\/$/, "");
  const url = `${base}/markets/${encodeURIComponent(t)}`;
  const res = await fetch(url);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`public market ${t}: HTTP ${res.status} ${JSON.stringify(j)}`);
  return j.market ?? j;
}

async function main() {
  const env = kalshiEnvFromMode();
  const rest = env.restBase;
  const m = await fetchPublicMarket(rest, ticker);
  const meta = {
    ticker: m.ticker,
    fractional_trading_enabled: m.fractional_trading_enabled,
    price_level_structure: m.price_level_structure,
    price_ranges: m.price_ranges,
    tick_size: m.tick_size,
  };
  console.error("[repro] market_meta", JSON.stringify(meta));

  const yb =
    m.yes_bid_dollars != null
      ? Number(m.yes_bid_dollars) * 100
      : m.yes_bid != null
        ? Number(m.yes_bid)
        : null;
  const ya =
    m.yes_ask_dollars != null
      ? Number(m.yes_ask_dollars) * 100
      : m.yes_ask != null
        ? Number(m.yes_ask)
        : null;
  if (yb == null || ya == null || !Number.isFinite(yb) || !Number.isFinite(ya)) {
    throw new Error("repro-rejection: missing yes bid/ask — cannot pick non-crossing probe price");
  }
  /** Post-only bid safely below best bid */
  let probeCents = Math.max(1, Math.floor(yb) - 2);
  if (probeCents >= ya) probeCents = Math.max(1, Math.floor(yb) - 1);

  const trader = new KalshiTrader({
    baseTradeUrl: rest,
    keyId: String(env.apiKeyId ?? ""),
    privateKey: loadPrivateKey({ path: env.privateKeyPath, inline: env.privateKeyInline }),
  });

  const body = trader.buildCreateOrderBody({
    ticker,
    mmSide: "yes_buy",
    priceCents: probeCents,
    sizeContracts: 1,
    clientOrderId: `repro-${Date.now()}`,
    postOnly: true,
  });
  console.error("[repro] create_order_body", JSON.stringify(body));

  if (dry) {
    console.error("[repro] MM_DRY_RUN=1 — skipping POST");
    return;
  }

  if (!env.apiKeyId?.trim()) throw new Error("Kalshi API key id missing for active run mode");

  try {
    const out = await trader.createOrder(body);
    console.error("[repro] ok", JSON.stringify(out));
  } catch (e) {
    const err = /** @type {any} */ (e);
    console.error(
      "[repro] Kalshi error",
      JSON.stringify(
        {
          message: err?.message,
          status: err?.status,
          body: err?.body,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

await main();
