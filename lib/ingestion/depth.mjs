/**
 * Kalshi L2 order-book depth ingestion for MM MVP (Week 1).
 *
 * Connects to the Kalshi WebSocket endpoint, subscribes to `orderbook_delta`
 * per configured market ticker, maintains an in-memory L2 book per market
 * from the initial `orderbook_snapshot` plus streaming `orderbook_delta`s,
 * downsamples to 1Hz, and writes top-10 levels per side to
 * `pmci.provider_market_depth`.
 *
 * Write-side client (`kalshi-trader.mjs`) is W2, not W1. Fair-value engine
 * and quoting engine are W3. Those are explicitly out of scope here.
 *
 * Spec references:
 *   - docs/plans/phase-mm-mvp-plan.md §"New components" #2 (this module)
 *   - https://docs.kalshi.com/getting_started/quick_start_websockets
 *   - lib/providers/kalshi-ws-auth.mjs for the RSA-PSS signer
 *
 * Kalshi message shape (verified 2026-04-24):
 *   - Subscribe: { id, cmd: "subscribe", params: { channels: ["orderbook_delta"], market_ticker } }
 *   - Responses:
 *       { type: "subscribed", msg: { sid, ... } }
 *       { type: "orderbook_snapshot", msg: { market_ticker, yes: [[p,q],...], no: [[p,q],...] } }
 *       { type: "orderbook_delta",    msg: { market_ticker, yes: [[p,q],...]?, no: [[p,q],...]? } }
 *       { type: "error", msg: { ... } }
 *   - A `qty` of 0 in a delta level means "remove this level".
 *   - `yes` and `no` are both BID ladders (YES-bids and NO-bids). The YES-ask
 *     price is derived as 100 - best_no_bid.
 */

import WebSocket from "ws";
import { buildWSHandshakeHeaders } from "../providers/kalshi-ws-auth.mjs";

export const TOP_K = 10;
export const DEFAULT_DOWNSAMPLE_MS = 1000;

// ---------------------------------------------------------------------------
// Pure state helpers — unit-testable without WebSocket or DB.
// ---------------------------------------------------------------------------

export function makeEmptyBook() {
  return {
    yes: new Map(), // price_cents -> qty
    no: new Map(),  // price_cents -> qty
    lastUpdateMs: null,
  };
}

/**
 * Replace book state from a snapshot message payload (`msg.msg`).
 * Clears both ladders and repopulates from yes/no arrays.
 */
export function applySnapshot(book, payload) {
  book.yes.clear();
  book.no.clear();
  for (const [price, qty] of payload?.yes || []) {
    if (qty > 0) book.yes.set(price, qty);
  }
  for (const [price, qty] of payload?.no || []) {
    if (qty > 0) book.no.set(price, qty);
  }
  book.lastUpdateMs = Date.now();
}

/**
 * Apply an incremental delta. qty=0 (or null) removes the level.
 * Leaves ladders untouched if the corresponding side is absent.
 */
export function applyDelta(book, payload) {
  const sides = [
    ["yes", payload?.yes],
    ["no", payload?.no],
  ];
  for (const [side, levels] of sides) {
    if (!Array.isArray(levels)) continue;
    const m = book[side];
    for (const [price, qty] of levels) {
      if (qty === 0 || qty == null) {
        m.delete(price);
      } else {
        m.set(price, qty);
      }
    }
  }
  book.lastUpdateMs = Date.now();
}

/**
 * Return the top-K levels from a ladder, sorted by price descending (best bid first).
 */
export function topKLevels(map, k = TOP_K) {
  return Array.from(map.entries())
    .sort((a, b) => b[0] - a[0])
    .slice(0, k);
}

/**
 * Compute YES-market mid and spread from raw YES/NO bid ladders.
 * Returns { mid_cents: number|null, spread_cents: number|null }.
 * NULLs when either side empty or book is crossed.
 */
export function computeMidAndSpread(book) {
  const yesTop = topKLevels(book.yes, 1);
  const noTop = topKLevels(book.no, 1);
  if (yesTop.length === 0 || noTop.length === 0) {
    return { mid_cents: null, spread_cents: null };
  }
  const bestYesBid = yesTop[0][0];
  const bestNoBid = noTop[0][0];
  const yesAsk = 100 - bestNoBid;
  if (yesAsk < bestYesBid) {
    // Crossed book — undefined mid/spread.
    return { mid_cents: null, spread_cents: null };
  }
  return {
    mid_cents: (bestYesBid + yesAsk) / 2,
    spread_cents: yesAsk - bestYesBid,
  };
}

/**
 * Build a `pmci.provider_market_depth` row from a book snapshot at observedAtMs.
 */
export function buildDepthRow(book, { providerMarketId, observedAtMs }) {
  const { mid_cents, spread_cents } = computeMidAndSpread(book);
  return {
    provider_market_id: providerMarketId,
    observed_at: new Date(observedAtMs).toISOString(),
    yes_levels: topKLevels(book.yes, TOP_K),
    no_levels: topKLevels(book.no, TOP_K),
    mid_cents,
    spread_cents,
  };
}

// ---------------------------------------------------------------------------
// Message dispatch — also pure, unit-testable.
// ---------------------------------------------------------------------------

/**
 * Dispatch a single parsed Kalshi WS message into the per-ticker book map.
 * Silently ignores messages for tickers not in `books`.
 */
export function handleMessage(msg, books, logger = console) {
  const type = msg?.type;
  if (!type) return;

  if (type === "subscribed") {
    const sid = msg?.msg?.sid;
    const ticker = msg?.msg?.market_ticker;
    logger.info?.(`depth WS subscribed sid=${sid} ticker=${ticker ?? "(n/a)"}`);
    return;
  }
  if (type === "error") {
    logger.error?.("depth WS error message", msg);
    return;
  }

  const payload = msg?.msg;
  const ticker = payload?.market_ticker;
  if (!ticker) return;
  const book = books.get(ticker);
  if (!book) {
    logger.warn?.(`depth WS message for unsubscribed ticker ${ticker}`);
    return;
  }
  if (type === "orderbook_snapshot") {
    applySnapshot(book, payload);
  } else if (type === "orderbook_delta") {
    applyDelta(book, payload);
  }
}

// ---------------------------------------------------------------------------
// Downsampler — 1Hz emitter, testable with fake timers + onRow spy.
// ---------------------------------------------------------------------------

/**
 * Start a periodic downsampler that emits one row per market per interval.
 * Returns a stop() function.
 */
export function startDownsampler({
  books,
  tickerToProviderMarketId,
  onRow,
  intervalMs = DEFAULT_DOWNSAMPLE_MS,
  logger = console,
} = {}) {
  const timer = setInterval(async () => {
    const now = Date.now();
    for (const [ticker, book] of books) {
      if (book.lastUpdateMs == null) continue;
      const providerMarketId = tickerToProviderMarketId.get(ticker);
      if (providerMarketId == null) continue;
      try {
        const row = buildDepthRow(book, { providerMarketId, observedAtMs: now });
        await onRow(row);
      } catch (err) {
        logger.error?.(`depth downsample write failed for ${ticker}`, err);
      }
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Supabase writer — idempotent upsert on (provider_market_id, observed_at).
// ---------------------------------------------------------------------------

export function makeSupabaseWriter(supabase, { table = "provider_market_depth", schema = "pmci", logger = console } = {}) {
  return async function writeDepthRow(row) {
    const { error } = await supabase
      .schema(schema)
      .from(table)
      .upsert(row, {
        onConflict: "provider_market_id,observed_at",
        ignoreDuplicates: true,
      });
    if (error) {
      logger.error?.("depth upsert failed", { error: error.message, row_keys: Object.keys(row) });
    }
  };
}

// ---------------------------------------------------------------------------
// Runtime entrypoint — composes WS + subscribe + dispatch + downsample + write.
// ---------------------------------------------------------------------------

/**
 * Start depth ingestion against Kalshi WS for a list of market tickers.
 * Returns { stop, books } where books is the in-memory book map (for observability / tests).
 *
 * @param {object} opts
 * @param {string[]} opts.marketTickers - Kalshi market tickers to subscribe.
 * @param {Map<string,bigint|number|string>} opts.tickerToProviderMarketId - ticker -> pmci.provider_markets.id
 * @param {string} opts.wsUrl - e.g. wss://demo-api.kalshi.co/trade-api/ws/v2
 * @param {string} opts.apiKeyId - KALSHI-ACCESS-KEY value
 * @param {crypto.KeyObject} opts.privateKey - loaded via kalshi-ws-auth loadPrivateKey
 * @param {object} opts.supabase - @supabase/supabase-js client
 * @param {number} [opts.downsampleIntervalMs=1000]
 * @param {object} [opts.logger=console]
 * @param {WebSocketCtor} [opts.WebSocketCtor=WebSocket] - injectable for tests
 */
export async function startDepthIngestion({
  marketTickers,
  tickerToProviderMarketId,
  wsUrl,
  apiKeyId,
  privateKey,
  supabase,
  downsampleIntervalMs = DEFAULT_DOWNSAMPLE_MS,
  logger = console,
  WebSocketCtor = WebSocket,
}) {
  if (!Array.isArray(marketTickers) || marketTickers.length === 0) {
    throw new Error("startDepthIngestion: marketTickers required");
  }
  if (!wsUrl) throw new Error("startDepthIngestion: wsUrl required");
  if (!apiKeyId) throw new Error("startDepthIngestion: apiKeyId required");
  if (!privateKey) throw new Error("startDepthIngestion: privateKey required");
  if (!supabase) throw new Error("startDepthIngestion: supabase client required");
  if (!tickerToProviderMarketId) {
    throw new Error("startDepthIngestion: tickerToProviderMarketId map required");
  }

  const books = new Map();
  for (const t of marketTickers) books.set(t, makeEmptyBook());

  // Derive path from wsUrl so the signature is exactly what Kalshi expects.
  const urlObj = new URL(wsUrl);
  const { headers } = buildWSHandshakeHeaders({
    privateKey,
    keyId: apiKeyId,
    path: urlObj.pathname,
  });

  const ws = new WebSocketCtor(wsUrl, { headers });
  const writeRow = makeSupabaseWriter(supabase, { logger });

  let subscribeIdCounter = 1;
  let stopDownsampler = null;

  await new Promise((resolve, reject) => {
    const onOpen = () => {
      logger.info?.(`depth WS connected to ${wsUrl}; subscribing to ${marketTickers.length} tickers`);
      for (const ticker of marketTickers) {
        ws.send(
          JSON.stringify({
            id: subscribeIdCounter++,
            cmd: "subscribe",
            params: { channels: ["orderbook_delta"], market_ticker: ticker },
          }),
        );
      }
      stopDownsampler = startDownsampler({
        books,
        tickerToProviderMarketId,
        onRow: writeRow,
        intervalMs: downsampleIntervalMs,
        logger,
      });
      resolve();
    };
    const onError = (err) => {
      logger.error?.("depth WS open/error", err);
      reject(err);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      logger.error?.("depth WS parse error", err);
      return;
    }
    handleMessage(msg, books, logger);
  });

  ws.on("close", (code, reason) => {
    logger.warn?.(`depth WS closed code=${code} reason=${reason?.toString?.() ?? ""}`);
    if (stopDownsampler) stopDownsampler();
  });

  ws.on("error", (err) => {
    logger.error?.("depth WS runtime error", err);
  });

  return {
    stop: () => {
      if (stopDownsampler) stopDownsampler();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
    books,
  };
}
