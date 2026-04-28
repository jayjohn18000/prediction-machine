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
export const RECONNECT_BACKOFF_BASE_MS = 1000;
export const RECONNECT_BACKOFF_CAP_MS = 30_000;

// Active ingestion books for `secondsSinceLastUpdate(ticker)` (single live instance; cleared on stop).
const stalenessRef = { books: null };

/**
 * Exponential reconnect delay: 1s, 2s, 4s, … capped at 30s (Group D / D1).
 * @param {number} attemptIndex - 0-based: first wait after a drop uses 0.
 * @returns {number} delay in ms
 */
export function reconnectBackoffMs(attemptIndex) {
  return Math.min(RECONNECT_BACKOFF_CAP_MS, RECONNECT_BACKOFF_BASE_MS * 2 ** attemptIndex);
}

/**
 * After a drop or handoff, clear L2 state and require a fresh `orderbook_snapshot` before DB rows.
 * Used on reconnect; exported for unit tests.
 */
export function resetDepthStateForReconnect(books, marketTickers, snapshotReceived) {
  for (const book of books.values()) {
    book.yes.clear();
    book.no.clear();
    book.lastUpdateMs = null;
  }
  for (const t of marketTickers) {
    snapshotReceived.set(t, false);
  }
}

/**
 * Seconds since last `orderbook_snapshot` or `orderbook_delta` for `ticker`.
 * Callers in W4+ risk: treat the result as "do not quote" when
 * `>= stale_quote_timeout_seconds` (with no active `startDepthIngestion`, this
 * always reads `Infinity` unless `booksOverride` is passed for tests).
 * @param {string} ticker
 * @param {Map<string, ReturnType<makeEmptyBook>>|undefined} [booksOverride] - for tests; production uses the active ingestor map
 * @returns {number} seconds; `Infinity` if no book, never updated, or no active ingestion
 */
export function secondsSinceLastUpdate(ticker, booksOverride) {
  const books = booksOverride ?? stalenessRef.books;
  if (!books) return Number.POSITIVE_INFINITY;
  const book = books.get(ticker);
  if (!book || book.lastUpdateMs == null) return Number.POSITIVE_INFINITY;
  return (Date.now() - book.lastUpdateMs) / 1000;
}

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
 * When `options.snapshotReceived` is set, an `orderbook_snapshot` flips the ticker to true (D3).
 * @param {object} [options]
 * @param {Map<string, boolean>|undefined} [options.snapshotReceived]
 */
export function handleMessage(msg, books, logger = console, options = {}) {
  const { snapshotReceived } = options;
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
    snapshotReceived?.set(ticker, true);
  } else if (type === "orderbook_delta") {
    applyDelta(book, payload);
  }
}

// ---------------------------------------------------------------------------
// Downsampler — 1Hz emitter, testable with fake timers + onRow spy.
// ---------------------------------------------------------------------------

/**
 * Start a periodic downsampler that emits one row per market per interval.
 * If `snapshotReceived` is provided, skips tickers that have not yet received
 * an `orderbook_snapshot` (avoids empty `yes_levels` / `no_levels` rows; D3).
 * Returns a stop() function.
 */
export function startDownsampler({
  books,
  tickerToProviderMarketId,
  onRow,
  intervalMs = DEFAULT_DOWNSAMPLE_MS,
  logger = console,
  snapshotReceived = null,
} = {}) {
  const timer = setInterval(async () => {
    const now = Date.now();
    for (const [ticker, book] of books) {
      if (snapshotReceived != null) {
        if (snapshotReceived.get(ticker) !== true) continue;
      }
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

/**
 * Same rows as {@link makeSupabaseWriter}, via direct Postgres (bypasses PostgREST / anon JWT).
 * Use on Fly when `SUPABASE_SERVICE_ROLE_KEY` is unset but `DATABASE_URL` is a privileged role.
 *
 * @param {import('pg').Client | import('pg').PoolClient} client
 */
export function makePgDepthWriter(client, { logger = console } = {}) {
  return async function writeDepthRow(row) {
    try {
      await client.query(
        `INSERT INTO pmci.provider_market_depth (
          provider_market_id, observed_at, yes_levels, no_levels, mid_cents, spread_cents
        ) VALUES ($1, $2::timestamptz, $3::jsonb, $4::jsonb, $5, $6)
        ON CONFLICT (provider_market_id, observed_at) DO NOTHING`,
        [
          row.provider_market_id,
          row.observed_at,
          JSON.stringify(row.yes_levels),
          JSON.stringify(row.no_levels),
          row.mid_cents,
          row.spread_cents,
        ],
      );
    } catch (err) {
      logger.error?.("depth pg insert failed", err);
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
 * @param {object} [opts.supabase] - @supabase/supabase-js client (required if `writeRow` omitted)
 * @param {function(object): Promise<void>} [opts.writeRow] - custom row writer; when set, `supabase` is not used
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
  writeRow: writeRowOpt,
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
  if (!tickerToProviderMarketId) {
    throw new Error("startDepthIngestion: tickerToProviderMarketId map required");
  }

  const writeRow =
    writeRowOpt ?? (supabase != null ? makeSupabaseWriter(supabase, { logger }) : null);
  if (!writeRow) {
    throw new Error("startDepthIngestion: supabase or writeRow required");
  }

  const books = new Map();
  for (const t of marketTickers) books.set(t, makeEmptyBook());
  const snapshotReceived = new Map();
  for (const t of marketTickers) snapshotReceived.set(t, false);

  stalenessRef.books = books;

  // Derive path from wsUrl so the signature is exactly what Kalshi expects.
  const urlObj = new URL(wsUrl);
  const { headers } = buildWSHandshakeHeaders({
    privateKey,
    keyId: apiKeyId,
    path: urlObj.pathname,
  });
  const snapshotReceivedMap = snapshotReceived;

  let ws = null;
  let stopDownsampler = null;
  let userStopped = false;
  let reconnectTimer = null;
  /** Consecutive close events while offline; used for backoff. Reset to 0 on every successful `open`. */
  let disconnectsSinceOpen = 0;
  let hasEverOpened = false;
  /** Awaited until first `open` resolves, else rejected. */
  let initialHandle = null;

  const onRawMessage = (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      logger.error?.("depth WS parse error", err);
      return;
    }
    handleMessage(msg, books, logger, { snapshotReceived: snapshotReceivedMap });
  };

  const subscribeAll = (socket) => {
    let subscribeId = 1;
    for (const ticker of marketTickers) {
      socket.send(
        JSON.stringify({
          id: subscribeId++,
          cmd: "subscribe",
          params: { channels: ["orderbook_delta"], market_ticker: ticker },
        }),
      );
    }
  };

  const scheduleReconnect = (trigger) => {
    if (userStopped) return;
    if (!hasEverOpened) return;
    if (reconnectTimer) return;
    resetDepthStateForReconnect(books, marketTickers, snapshotReceivedMap);
    const attemptIndex = Math.max(0, disconnectsSinceOpen - 1);
    const nextDelayMs = reconnectBackoffMs(attemptIndex);
    logger.info?.("depth.reconnect.attempt", {
      attempt: disconnectsSinceOpen,
      nextDelayMs,
      trigger,
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      attachSocket();
    }, nextDelayMs);
  };

  const attachSocket = () => {
    if (userStopped) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try {
        ws.removeAllListeners();
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
    const socket = new WebSocketCtor(wsUrl, { headers });
    ws = socket;

    /* DO NOT MOVE — message handler must be attached pre-subscribe to avoid the
     * open-window drop noted in agent 01 §G3. Early frames (snapshot/delta) must
     * not be missed between `open` and `send(subscribe)`.
     */
    socket.on("message", onRawMessage);

    socket.on("error", (err) => {
      if (initialHandle) {
        const rej = initialHandle.reject;
        initialHandle = null;
        rej(err);
        return;
      }
      logger.error?.("depth WS runtime error", err);
      // Terminal errors are followed by `close`; if `close` is omitted, still recover.
      if (userStopped || !hasEverOpened) return;
      if (reconnectTimer) return;
      disconnectsSinceOpen += 1;
      scheduleReconnect("error");
    });

    socket.on("open", () => {
      if (initialHandle) {
        hasEverOpened = true;
        initialHandle.resolve();
        initialHandle = null;
      } else if (disconnectsSinceOpen > 0) {
        logger.info?.("depth.reconnect.success", { priorDisconnects: disconnectsSinceOpen });
      }
      disconnectsSinceOpen = 0;
      logger.info?.(`depth WS connected to ${wsUrl}; subscribing to ${marketTickers.length} tickers`);
      subscribeAll(socket);
      if (!stopDownsampler) {
        stopDownsampler = startDownsampler({
          books,
          tickerToProviderMarketId,
          onRow: writeRow,
          intervalMs: downsampleIntervalMs,
          logger,
          snapshotReceived: snapshotReceivedMap,
        });
      }
    });

    socket.on("close", (code, reason) => {
      logger.warn?.(`depth WS closed code=${code} reason=${reason?.toString?.() ?? ""}`);
      if (userStopped) return;
      if (initialHandle) {
        initialHandle.reject(new Error("WebSocket closed before open"));
        initialHandle = null;
        return;
      }
      if (!hasEverOpened) return;
      if (reconnectTimer) return;
      disconnectsSinceOpen += 1;
      scheduleReconnect("close");
    });
  };

  await new Promise((resolve, reject) => {
    initialHandle = { resolve, reject };
    attachSocket();
  });

  return {
    stop: () => {
      userStopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (stopDownsampler) {
        stopDownsampler();
        stopDownsampler = null;
      }
      if (ws) {
        try {
          ws.removeAllListeners();
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
      stalenessRef.books = null;
    },
    books,
  };
}
