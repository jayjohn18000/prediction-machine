/**
 * Track J — WebSocket PING heartbeat keeps DEMO depth subscriptions alive.
 */

import crypto from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import WebSocket from "ws";

import { startDepthIngestion } from "../../lib/ingestion/depth.mjs";

test("depth ingestion sends periodic ws.ping (≥1 within 30s of open); stop clears timer", async () => {
  const ticker = "KX-TRACK-J-HB";
  const tickerToProviderMarketId = new Map([[ticker, 901_337]]);

  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });

  const pingStats = { count: 0 };

  const server = await new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () =>
      resolve(wss),
    );
    wss.on("error", reject);
    wss.on("connection", (sock) => {
      sock.on("ping", () => {
        pingStats.count += 1;
      });

      sock.on("message", (raw) => {
        let cmd;
        try {
          cmd = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (cmd?.cmd !== "subscribe") return;
        const t = cmd?.params?.market_ticker ?? ticker;
        sock.send(JSON.stringify({ type: "subscribed", msg: { sid: Number(cmd?.id ?? 1), market_ticker: t } }));
        sock.send(
          JSON.stringify({
            type: "orderbook_snapshot",
            msg: { market_ticker: t, yes: [[50, 1]], no: [[48, 1]] },
          }),
        );
      });
    });
  });

  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const wsUrl = `ws://127.0.0.1:${port}/`;

  /** @type {null | Awaited<ReturnType<typeof startDepthIngestion>>} */
  let ingestor = null;
  try {
    ingestor = await startDepthIngestion({
      marketTickers: [ticker],
      tickerToProviderMarketId,
      wsUrl,
      apiKeyId: "test-key-track-j-hb",
      privateKey,
      writeRow: async () => {},
      subscribeSpacingMs: 0,
      logger: /** @type {any} */ ({ info() {}, warn() {}, error() {} }),
      WebSocketCtor: WebSocket,
    });

    await new Promise((r) => setTimeout(r, 26_000));

    assert.ok(pingStats.count >= 1, `expected ≥1 protocol PING from client within 26s; got ${pingStats.count}`);

    const afterFirstWindow = pingStats.count;
    ingestor.stop();

    await new Promise((r) => setTimeout(r, 3500));

    assert.equal(pingStats.count, afterFirstWindow, `expected no PING after stop(); got increase ${pingStats.count - afterFirstWindow}`);
  } finally {
    ingestor?.stop();
    await new Promise((res) =>
      server.close(() => res()),
    );
  }
});
