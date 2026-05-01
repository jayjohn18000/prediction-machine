/**
 * Track J Layer 2 — majority stale books schedule reconnect (watchdog).
 */

import crypto from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import WebSocket from "ws";

import { startDepthIngestion } from "../../lib/ingestion/depth.mjs";

test("staleness watchdog forces reconnect when >50% of tickers never update", async () => {
  const tickers = Array.from({ length: 8 }, (_, i) => `KX-WD-${i}`);
  const tickerToProviderMarketId = new Map(tickers.map((t, i) => [t, 800_000 + i]));

  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });

  let connectionCount = 0;
  const aliveTicker = tickers[0];

  const server = await new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () =>
      resolve(wss),
    );
    wss.on("error", reject);
    wss.on("connection", (sock) => {
      connectionCount += 1;
      /** @type {ReturnType<typeof setInterval> | null} */
      let tickTimer = null;
      sock.on("message", (raw) => {
        let cmd;
        try {
          cmd = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (cmd?.cmd !== "subscribe") return;
        const ticker = cmd?.params?.market_ticker;

        sock.send(JSON.stringify({
          type: "subscribed",
          msg: { sid: Number(cmd?.id ?? 1), market_ticker: ticker },
        }));

        if (ticker === aliveTicker && sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({
            type: "orderbook_snapshot",
            msg: {
              market_ticker: ticker,
              yes: [[50, 10]],
              no: [[48, 10]],
            },
          }));
        }
      });

      tickTimer = setInterval(() => {
        if (sock.readyState !== WebSocket.OPEN) return;
        sock.send(
          JSON.stringify({
            type: "orderbook_delta",
            msg: {
              market_ticker: aliveTicker,
              yes: [[50, Number((Math.random() * 5).toFixed(2))]],
            },
          }),
        );
      }, 400);
      if (tickTimer.unref) tickTimer.unref();

      sock.on("close", () => {
        if (tickTimer) {
          clearInterval(tickTimer);
          tickTimer = null;
        }
      });
    });
  });

  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const wsUrl = `ws://127.0.0.1:${port}/`;

  /** @type {null | Awaited<ReturnType<typeof startDepthIngestion>>} */
  let ingestor = null;
  try {
    ingestor = await startDepthIngestion({
      marketTickers: tickers,
      tickerToProviderMarketId,
      wsUrl,
      apiKeyId: "test-key-watchdog",
      privateKey,
      writeRow: async () => {},
      subscribeSpacingMs: 0,
      logger: /** @type {any} */ ({ info() {}, warn() {}, error() {} }),
      WebSocketCtor: WebSocket,
    });

    await new Promise((r) => setTimeout(r, 95_000));

    assert.ok(
      connectionCount >= 2,
      `expected watchdog reconnect (≥2 WS connections); got ${connectionCount}`,
    );
  } finally {
    ingestor?.stop();
    await new Promise((res) =>
      server.close(() => res()),
    );
  }
});
