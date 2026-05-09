#!/usr/bin/env node
/**
 * Phase 0 normalizer — Kalshi PROD websocket + selective NBA CDN poll.
 * Stream A: S3 envelopes + sampled placeholders (Kalshi). Stream B: NBA lag gates, microstructure, resolution loop.
 */

import crypto from "node:crypto";
import pg from "pg";
import WebSocket from "ws";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { kalshiEnvFromMode } from "../../lib/mm/kalshi-env.mjs";
import { buildWSHandshakeHeaders, loadPrivateKey } from "../../lib/providers/kalshi-ws-auth.mjs";
import { resetDepthStateForReconnect } from "../../lib/ingestion/depth.mjs";
import {
  createMicrostructureBookState,
  applyKalshiWsToBooks,
  maybeLogMicrostructureSignal,
} from "./detectors/microstructure-scoring.mjs";
import {
  processNbaPlayByPlayDigest,
  WpaRollingP75,
  resolveAgedInformationalLagSignals,
} from "./detectors/nba-informational-lag.mjs";

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const AWS_REGION = process.env.AWS_REGION?.trim() || "us-east-2";
const S3_BUCKET = process.env.S3_BUCKET?.trim() || "pmci-events";
const SOURCE_CHAIN_KALSHI =
  process.env.SOURCE_CHAIN_KALSHI?.trim() || "cccc3333-e89b-12d3-a456-426614174002";
const SOURCE_CHAIN_NBA =
  process.env.SOURCE_CHAIN_NBA?.trim() || "aaaa1111-e89b-12d3-a456-426614174000";

const POLL_MS = Math.min(30_000, Math.max(2000, Number(process.env.NBA_POLL_INTERVAL_MS || 4000) || 4000));
const SAMPLE_MS = Math.min(120_000, Math.max(500, Number(process.env.PMCI_NORMALIZER_DB_SAMPLE_MS || 4000) || 4000));
const EXTRA_NBA_IDS = (process.env.NBA_GAME_IDS_EXTRA || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SUB_SPACE_MS = Math.min(250, Math.max(80, Number(process.env.KALSHI_SUBSCRIBE_SPACING_MS || 125) || 125));
const MICRO_MS = Math.min(5000, Math.max(500, Number(process.env.PMCI_NORMALIZER_MICROSTRUCTURE_MS || 1000) || 1000));

if (!DATABASE_URL) {
  console.error("pmci-normalizer: DATABASE_URL is required");
  process.exit(1);
}

/** @typedef {{ ticker: string, sport: string|null, tpl: Record<string, unknown>|null }} MarketRow */

/** @returns {Promise<MarketRow[]>} */
async function loadEnabledKalshi(pgClient) {
  const r = await pgClient.query(
    `
    SELECT
      pm.provider_market_ref AS ticker,
      pm.sport AS sport,
      COALESCE(pm.template_params, '{}'::jsonb)::json AS tpl
    FROM pmci.mm_market_config mmc
    JOIN pmci.provider_markets pm ON pm.id = mmc.market_id
    JOIN pmci.providers pr ON pr.id = pm.provider_id AND pr.code = 'kalshi'
    WHERE mmc.enabled = TRUE
      AND pm.provider_market_ref IS NOT NULL
    `,
  );
  return (r.rows || []).map((row) => ({
    ticker: String(row.ticker),
    sport: row.sport != null ? String(row.sport) : null,
    tpl: typeof row.tpl === "object" && row.tpl != null ? row.tpl : {},
  }));
}

/**
 * Persist envelope → S3 + placeholder scanner_informational_lag_signals row (strength 0).
 *
 * @param {object} p
 */
async function ingestEnvelope(p) {
  const {
    s3,
    pgClient,
    counters,
    sourceTag,
    sourceChainId,
    marketTicker,
    payload,
    gameId,
    eventType,
  } = p;

  const observedAt = new Date();
  const iso = observedAt.toISOString();
  const eventId = crypto.randomUUID();

  const envelope = {
    source_chain_id: sourceChainId,
    observed_at: iso,
    market_ticker: marketTicker,
    payload,
  };

  const body = Buffer.from(JSON.stringify(envelope));
  const day = iso.slice(0, 10);
  const hour = iso.slice(11, 13);
  const key = `raw/${sourceTag}/${day}/${hour}/${eventId}.json`;

  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/json",
    }),
  );

  counters[sourceTag] = (counters[sourceTag] ?? 0) + 1;

  await pgClient.query(
    `
    INSERT INTO pmci.scanner_informational_lag_signals (
      observed_at,
      market_ticker,
      signal_strength_cents,
      source_chain_id,
      game_id,
      event_type,
      external_event_at,
      notes
    ) VALUES (
      $1::timestamptz,
      $2::text,
      0::numeric,
      $3::uuid,
      $4::text,
      $5::text,
      $1::timestamptz,
      jsonb_build_object('s3_key', $6::text, 'stream_phase', $7::text)
    )
    `,
    [
      iso,
      marketTicker,
      sourceChainId,
      gameId,
      eventType,
      key,
      "stream_a_raw_provenance_v1",
    ],
  );

  counters.db_writes = (counters.db_writes ?? 0) + 1;
}

/**
 * S3 raw envelope only (Stream B NBA path — no strength-0 scanner row).
 * @param {object} p
 */
async function uploadS3Raw(p) {
  const { s3, counters, sourceTag, marketTicker, payload, gameId, eventType, sourceChainId } = p;
  const observedAt = new Date();
  const iso = observedAt.toISOString();
  const eventId = crypto.randomUUID();
  const envelope = {
    source_chain_id: sourceChainId,
    observed_at: iso,
    market_ticker: marketTicker,
    payload,
  };
  const body = Buffer.from(JSON.stringify(envelope));
  const day = iso.slice(0, 10);
  const hour = iso.slice(11, 13);
  const key = `raw/${sourceTag}/${day}/${hour}/${eventId}.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/json",
    }),
  );
  counters[sourceTag] = (counters[sourceTag] ?? 0) + 1;
}

async function deriveNbaGameIds(markets) {
  const ids = new Set(EXTRA_NBA_IDS);
  for (const row of markets) {
    const tg = row.tpl?.nba_canonical_game_id ?? row.tpl?.nba_game_id ?? row.tpl?.game_id_nba_stats;
    if (tg != null && String(tg).trim()) ids.add(String(tg));
  }

  /** Optional scoreboard widen when NBAGAME tickers configured (operator-controlled). */
  if (process.env.NBA_AUTODISCOVER_GAME_IDS === "1") {
    try {
      const res = await fetch(
        "https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard.json",
        { headers: { Accept: "application/json" } },
      );
      if (res.ok) {
        const j = await res.json();
        const games = Array.isArray(j?.scoreboard?.games) ? j.scoreboard.games : [];
        const wantsNbaGames = markets.some((m) => (m?.ticker || "").toUpperCase().includes("KXNBAGAME"));
        if (wantsNbaGames) {
          for (const game of games) {
            const gid = game?.gameId;
            if (gid != null && String(game?.gameStatus || "").toUpperCase().includes("Q")) ids.add(String(gid));
          }
        }
      }
    } catch {
      /* ignore widen failures */
    }
  }
  return ids;
}

/**
 * Bootstrap / restart Kalshi WS when ticker universe fingerprint changes.
 */
function kalshiTickerFingerprint(tickers) {
  return [...tickers].sort().join("|");
}

function startKalshiWs({ tickers, lastPayload, onParsed, onOpen }) {
  if (!tickers.length) return { close: () => {} };

  const k = kalshiEnvFromMode("prod");
  if (!k.apiKeyId || (!k.privateKeyInline && !k.privateKeyPath)) {
    console.error("[pmci-normalizer] Kalshi prod keys missing — idle until configured");
    return { close: () => {} };
  }

  let wsUrl = k.wsUrl;
  if (!wsUrl) throw new Error("Kalshi WS URL absent");
  if (/demo-api/i.test(wsUrl)) {
    console.error("[pmci-normalizer] Refusing DEMO Kalshi websocket URL (ADR-012 PROD-only invariant).");
    return { close: () => {} };
  }

  const privateKey = loadPrivateKey({
    inline: k.privateKeyInline,
    path: k.privateKeyPath,
  });
  const wsPath = new URL(wsUrl).pathname || "/trade-api/ws/v2";

  let sock = /** @type {WebSocket|null} */ (null);
  let stopped = false;
  let backoff = 1000;
  /** @returns {Promise<void>} */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const attach = async () => {
    if (stopped) return;

    try {
      const { headers } = buildWSHandshakeHeaders({ privateKey, keyId: k.apiKeyId, path: wsPath });
      sock = new WebSocket(wsUrl, { headers });
    } catch (e) {
      console.error("[pmci-normalizer] Kalshi handshake failed:", /** @type {Error} */ (e)?.message ?? e);
      setTimeout(() => {
        backoff = Math.min(backoff * 2, 60_000);
        attach();
      }, backoff);
      return;
    }

    sock.on("open", () => {
      onOpen?.();
      console.log(`[pmci-normalizer] kalshi_ws open tickers=${tickers.length} subscribe_spacing_ms=${SUB_SPACE_MS}`);
      backoff = 1000;

      /** @returns {Promise<void>} */
      (async () => {
        try {
          let sid = 1;
          for (const tkr of tickers) {
            if (!sock || sock.readyState !== WebSocket.OPEN) break;
            sock.send(
              JSON.stringify({
                id: sid++,
                cmd: "subscribe",
                params: { channels: ["orderbook_delta"], market_ticker: tkr },
              }),
            );
            await sleep(SUB_SPACE_MS);
          }
        } catch (err) {
          console.error("[pmci-normalizer] subscribe burst error:", /** @type {Error} */ (err)?.message ?? err);
        }
      })();
    });

    sock.on("message", (buf) => {
      try {
        const txt = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
        const parsed = JSON.parse(txt);
        const tkr =
          parsed?.msg?.market_ticker ??
          parsed?.market_ticker ??
          parsed?.data?.market_ticker ??
          "__unknown__";

        lastPayload.set(String(tkr), {
          envelope: envelopeFromKalshi(parsed),
          received_at_iso: new Date().toISOString(),
        });
        onParsed?.(parsed);
      } catch {
        /* malformed frame */
      }
    });

    sock.on("ping", () => {
      try {
        sock?.pong?.();
      } catch {
        /* ignore */
      }
    });

    sock.on("error", () => {});
    sock.on("close", () => {
      if (stopped) return;
      sock = null;
      setTimeout(() => {
        backoff = Math.min(backoff * 2, 60_000);
        attach();
      }, backoff);
      console.warn(`[pmci-normalizer] kalshi_ws reconnect in ${backoff}ms`);
    });
  };

  void attach();

  return {
    close: () => {
      stopped = true;
      try {
        sock?.removeAllListeners();
        sock?.close();
      } catch {
        /* ignore */
      }
      sock = null;
    },
  };
}

/** @returns {unknown} */
function envelopeFromKalshi(parsed) {
  try {
    return {
      kalshi_raw_type: parsed?.type ?? null,
      kalshi_payload: parsed,
    };
  } catch {
    return { kalshi_payload: parsed };
  }
}

async function main() {
  const counters /** @type {Record<string, number>} */ = { kalshi_ws: 0, cdn_nba: 0, db_writes: 0 };
  const s3 = new S3Client({ region: AWS_REGION });
  const pgClient = new pg.Client({
    connectionString: DATABASE_URL,
    ssl:
      DATABASE_URL.includes("amazonaws") || DATABASE_URL.includes("supabase.co")
        ? { rejectUnauthorized: false }
        : undefined,
  });
  await pgClient.connect();

  /** @type {MarketRow[]} */
  let cachedMarkets = await loadEnabledKalshi(pgClient);
  /** @type {Map<string, {envelope: unknown, received_at_iso: string}>} */
  const lastKalshiPayload = new Map();
  /** @type {Record<string, number>} */
  let lastKalshiFlushMs /** @type {Record<string, number>} */ = {};
  /** @type {{ close: () => void } | null} */
  let wsHandle = null;
  /** @type {string} */
  let wsFp = "";

  /** Stream B: depth books for microstructure detector */
  const depthCtx = {
    /** @type {Map<string, ReturnType<typeof import("../../lib/ingestion/depth.mjs").makeEmptyBook>>} */
    books: new Map(),
    /** @type {Map<string, boolean>} */
    snapshotReceived: new Map(),
    /** @type {Map<string, { midHistory: { t: number, mid: number }[] }>} */
    microSt: new Map(),
    /** @type {Record<string, number>} */
    lastMicroMs: {},
  };

  function syncDepthBooks(tickerList) {
    const x = createMicrostructureBookState(tickerList);
    depthCtx.books = x.books;
    depthCtx.snapshotReceived = x.snapshotReceived;
    depthCtx.microSt = x.microSt;
    depthCtx.lastMicroMs = {};
  }

  const nbaRolling = new WpaRollingP75();
  /** @type {Record<string, number>} */
  const nbaActionCursor = {};

  const resolutionTimer = setInterval(() => {
    void resolveAgedInformationalLagSignals(pgClient).catch((e) =>
      console.error("[pmci-normalizer] nba resolution:", /** @type {Error} */ (e)?.message ?? e),
    );
  }, 60_000);

  /** @param {string[]} tickerArr */
  function kalshiWsHooks(tickerArr) {
    return {
      onOpen: () => {
        resetDepthStateForReconnect(depthCtx.books, tickerArr, depthCtx.snapshotReceived);
      },
      onParsed: (/** @type {object} */ parsed) => {
        applyKalshiWsToBooks(parsed, depthCtx.books, depthCtx.snapshotReceived);
        const tkr = String(
          parsed?.msg?.market_ticker ?? parsed?.market_ticker ?? parsed?.data?.market_ticker ?? "",
        );
        if (!tkr || tkr === "__unknown__") return;
        const tNow = Date.now();
        if (!depthCtx.snapshotReceived.get(tkr)) return;
        if (tNow - (depthCtx.lastMicroMs[tkr] ?? 0) < MICRO_MS) return;
        depthCtx.lastMicroMs[tkr] = tNow;
        const book = depthCtx.books.get(tkr);
        const st = depthCtx.microSt.get(tkr);
        if (!book || !st) return;
        void maybeLogMicrostructureSignal(pgClient, tkr, book, st, { now: tNow }).catch((e) =>
          console.error("[pmci-normalizer] microstructure:", /** @type {Error} */ (e)?.message ?? e),
        );
      },
    };
  }

  const throughputTimer = setInterval(() => {
    console.log(
      "[pmci-normalizer] throughput_counters",
      JSON.stringify({
        kalshi_writes: counters.kalshi_ws,
        nba_writes: counters["cdn.nba.com"] ?? 0,
        db_writes: counters.db_writes,
        kalshi_topics: cachedMarkets.length,
        kalshi_cached_payloads: lastKalshiPayload.size,
      }),
    );
    counters.kalshi_ws = 0;
    counters["cdn.nba.com"] = 0;
    counters.db_writes = 0;
  }, 30_000);

  const refreshTimer = setInterval(async () => {
    try {
      cachedMarkets = await loadEnabledKalshi(pgClient);
    } catch (e) {
      console.error("[pmci-normalizer] market reload:", /** @type {Error} */ (e)?.message ?? e);
    }
  }, 30_000);

  const initialTickers = cachedMarkets.map((r) => r.ticker).filter(Boolean);
  syncDepthBooks(initialTickers);
  wsFp = kalshiTickerFingerprint(initialTickers);
  wsHandle = startKalshiWs({
    tickers: initialTickers,
    lastPayload: lastKalshiPayload,
    ...kalshiWsHooks(initialTickers),
  });

  const nbaDigests /** @type {Record<string,string>} */ = {};

  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));

      cachedMarkets = await loadEnabledKalshi(pgClient).catch(() => cachedMarkets);

      const tickers = cachedMarkets.map((r) => r.ticker).filter(Boolean);
      const fp = kalshiTickerFingerprint(tickers);

      if (fp !== wsFp) {
        wsHandle?.close();
        wsFp = fp;
        lastKalshiPayload.clear();
        lastKalshiFlushMs = {};
        syncDepthBooks(tickers);
        wsHandle = startKalshiWs({ tickers, lastPayload: lastKalshiPayload, ...kalshiWsHooks(tickers) });
      }

      const now = Date.now();

      /** Sample Kalshi book traffic into S3/PG throttle */
      for (const row of cachedMarkets) {
        const t = row.ticker;
        const last = lastKalshiPayload.get(t);
        const lastFlush = lastKalshiFlushMs[t] ?? 0;
        if (!last?.envelope || now - lastFlush < SAMPLE_MS) continue;

        const envSnap =
          typeof last.envelope === "object" && last.envelope !== null ? last.envelope : {};
        await ingestEnvelope({
          s3,
          pgClient,
          counters,
          sourceTag: "kalshi_ws",
          sourceChainId: SOURCE_CHAIN_KALSHI,
          marketTicker: t,
          payload: { ...envSnap, event_type: "sampled_orderbook_traffic_v1" },
          gameId: t,
          eventType: "kalshi_ws_sample_v1",
        });
        lastKalshiFlushMs[t] = now;

      }

      /** NBA CDN poller — change-digest keyed */
      const nbaGames = [...(await deriveNbaGameIds(cachedMarkets))];
      if (nbaGames.length) {
        for (const gameId of nbaGames) {
          const url = `https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${gameId}.json`;

          /** @type {globalThis.fetch} */
          const doFetch = globalThis.fetch.bind(globalThis);
          const res = await doFetch(url, { headers: { Accept: "application/json" } });
          if (!res.ok) {
            counters.nba_http_fail = (counters.nba_http_fail ?? 0) + 1;
            continue;
          }
          let json /** @type {unknown} */;
          json = await res.json();
          const digest = crypto.createHash("sha256").update(JSON.stringify(json)).digest("hex");

          const prev = nbaDigests[gameId];
          if (prev === digest) continue;
          nbaDigests[gameId] = digest;

          await uploadS3Raw({
            s3,
            counters,
            sourceTag: "cdn.nba.com",
            sourceChainId: SOURCE_CHAIN_NBA,
            marketTicker: `NBA-PBP-${gameId}`,
            payload: {
              event_type: "nba_playbyplay_digest_v1",
              digest_sha256_hex: digest,
              raw_playbyplay: json,
              game_id: gameId,
            },
            gameId: String(gameId),
            eventType: "nba_playbyplay_digest_v1",
          });

          const lastIdx = nbaActionCursor[gameId] ?? -1;
          await processNbaPlayByPlayDigest({
            pgClient,
            gameId: String(gameId),
            json,
            rollingP75: nbaRolling,
            lastProcessedIndex: lastIdx,
            markProcessed: (idx) => {
              nbaActionCursor[gameId] = idx;
            },
          });
        }
      }

      counters.loop_tick = (counters.loop_tick ?? 0) + 1;
    }
  } finally {
    clearInterval(refreshTimer);
    clearInterval(throughputTimer);
    clearInterval(resolutionTimer);
    wsHandle?.close();
    await pgClient.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error("[pmci-normalizer] fatal", e);
  process.exit(1);
});
