/**
 * Track I regression: DEMO Kalshi WS coalesces or rate-limits back-to-back
 * subscribe frames so only ~1 ticker keeps streaming deltas unless subscribes
 * are paced (see lib/ingestion/depth.mjs subscribeSpacingMs).
 */

import crypto from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import WebSocket from "ws";

import {
  DEFAULT_SUBSCRIBE_SPACING_MS,
  secondsSinceLastUpdate,
  startDepthIngestion,
} from "../../lib/ingestion/depth.mjs";

/** Mock server: burst subscribes coalesce — only last ticker earns delta stream until next gap≥MIN_GAP_MS. */
/**
 * Snapshot lastUpdate timestamps, wait, recount how many tickers strictly advanced.
 * Snapshot-only installs do not tick forward here.
 *
 * @param {Map<string, { lastUpdateMs: number|null }>} books
 * @param {string[]} tickers
 * @param {number} dwellMs
 * @returns {Promise<number>}
 */
async function countBooksWithAdvancingTs(books, tickers, dwellMs) {
  const before = tickers.map((tick) => books.get(tick)?.lastUpdateMs ?? 0);
  await new Promise((r) => setTimeout(r, dwellMs));
  const after = tickers.map((tick) => books.get(tick)?.lastUpdateMs ?? 0);
  return after.reduce((n, ms, idx) => n + (ms > before[idx] ? 1 : 0), 0);
}

async function mockKalshiDepthServer(opts = {}) {
  const minGapMs = opts.minGapMs ?? 90;
  /** @type {Set<string>} */
  let receivesDeltas = new Set();
  let prevSubscribeAtMs = Number.NEGATIVE_INFINITY;
  /** @type {ReturnType<typeof setInterval> | null} */
  let tickTimer = null;

  const server = await new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () =>
      resolve(wss),
    );
    wss.on("error", reject);
    wss.on("connection", (sock) => {
      tickTimer = setInterval(() => {
        for (const t of receivesDeltas) {
          if (sock.readyState !== WebSocket.OPEN) continue;
          sock.send(
            JSON.stringify({
              type: "orderbook_delta",
              msg: {
                market_ticker: t,
                yes: [[50, Number((Math.random() * 100).toFixed(4))]],
              },
            }),
          );
        }
      }, 200);
      if (tickTimer?.unref) tickTimer.unref();

      sock.on("message", (raw) => {
        let cmd;
        try {
          cmd = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (cmd?.cmd !== "subscribe") return;
        const ticker = cmd?.params?.market_ticker;
        if (!ticker) return;
        const now = Date.now();
        const gap = prevSubscribeAtMs === Number.NEGATIVE_INFINITY ? 1e12 : now - prevSubscribeAtMs;
        prevSubscribeAtMs = now;

        if (gap >= minGapMs) receivesDeltas.add(ticker);
        else {
          receivesDeltas = new Set([ticker]);
        }

        if (sock.readyState !== WebSocket.OPEN) return;
        sock.send(
          JSON.stringify({
            type: "subscribed",
            msg: { sid: Number(cmd?.id ?? 1), market_ticker: ticker },
          }),
        );
        sock.send(
          JSON.stringify({
            type: "orderbook_snapshot",
            msg: {
              market_ticker: ticker,
              yes: [[50, 100]],
              no: [[48, 60]],
            },
          }),
        );
      });

      sock.on("close", () => {
        if (tickTimer) {
          clearInterval(tickTimer);
          tickTimer = null;
        }
      });
    });
  });

  const port = server.address().port;
  return {
    wsUrl: `ws://127.0.0.1:${port}/`,
    cleanup: async () =>
      new Promise((res) =>
        server.close(() => res()),
      ),
  };
}

test("burst subscribe mitigation: spaced subscribes keep all books fresh (~60s window compressed)", async () => {
  const tickers = Array.from({ length: 8 }, (_, i) => `KX-TRACK-I-${String(i)}`);
  const tickerToProviderMarketId = new Map(tickers.map((t, i) => [t, i + 100_000]));

  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });

  const { wsUrl, cleanup } = await mockKalshiDepthServer({});
  /** @type {null | ReturnType<typeof startDepthIngestion> extends Promise<infer X> ? X : never} */
  let ingestor = null;
  try {
    ingestor = await startDepthIngestion({
      marketTickers: tickers,
      tickerToProviderMarketId,
      wsUrl,
      apiKeyId: "test-key-track-i",
      privateKey,
      writeRow: async () => {},
      subscribeSpacingMs: DEFAULT_SUBSCRIBE_SPACING_MS,
      logger: /** @type {any} */ ({ info() {}, warn() {}, error() {} }),
      WebSocketCtor: WebSocket,
    });

    const subscribeSweepMs =
      DEFAULT_SUBSCRIBE_SPACING_MS * Math.max(0, tickers.length - 1) + 2500;

    await new Promise((r) => setTimeout(r, subscribeSweepMs));

    const staleSeconds = [];
    for (const t of tickers) {
      staleSeconds.push(secondsSinceLastUpdate(t, ingestor.books));
    }
    const advancing = await countBooksWithAdvancingTs(ingestor.books, tickers, 1600);
    const worst = Math.max(...staleSeconds.filter(Number.isFinite));
    assert.ok(
      worst < 120,
      `expected sustained updates for all tickers (<120s); ages=${JSON.stringify(staleSeconds)}`,
    );
    assert.equal(advancing, tickers.length, "every book should advance from streaming deltas after subscribe sweep");
  } finally {
    ingestor?.stop();
    await cleanup();
  }
});

test("mock Kalshi proves burst spacing=0 strands all but last ticker unless spaced", async () => {
  const tickers = Array.from({ length: 8 }, (_, i) => `KX-BURST-${String(i)}`);
  const tickerToProviderMarketId = new Map(tickers.map((t, i) => [t, i + 50_000]));

  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });

  const { wsUrl, cleanup } = await mockKalshiDepthServer({});
  /** @type {null | ReturnType<typeof startDepthIngestion> extends Promise<infer X> ? X : never} */
  let ingestor = null;
  try {
    ingestor = await startDepthIngestion({
      marketTickers: tickers,
      tickerToProviderMarketId,
      wsUrl,
      apiKeyId: "test-key-burst",
      privateKey,
      writeRow: async () => {},
      subscribeSpacingMs: 0,
      logger: /** @type {any} */ ({ info() {}, warn() {}, error() {} }),
      WebSocketCtor: WebSocket,
    });

    await new Promise((r) => setTimeout(r, 2000));

    const advancingBurst = await countBooksWithAdvancingTs(ingestor.books, tickers, 1600);

    assert.equal(
      advancingBurst,
      1,
      "burst-only subscribe should leave exactly one ticker receiving deltas (mock Kalshi semantics)",
    );
  } finally {
    ingestor?.stop();
    await cleanup();
  }
});
