/**
 * Track B — institutional-style microstructure score; writes pmci.scanner_structural_signals.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeEmptyBook,
  handleMessage,
  topKLevels,
  computeMidAndSpread,
} from "../../../lib/ingestion/depth.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Load weights from repo root lib/scanner (normalizer cwd may be pmci-normalizer). */
function loadWeights() {
  const tryPaths = [
    join(process.cwd(), "lib/scanner/microstructure-weights.json"),
    join(__dirname, "../../../lib/scanner/microstructure-weights.json"),
  ];
  for (const p of tryPaths) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* try next */
    }
  }
  throw new Error("microstructure-weights.json not found");
}

const W = loadWeights();

const SOURCE_CHAIN_MICRO =
  process.env.SOURCE_CHAIN_MICRO?.trim() || "cccc3333-e89b-12d3-a456-426614174002";

/** @typedef {{ midHistory: { t: number, mid: number }[] }} MicroTickerState */

/**
 * @param {import("pg").Client} pgClient
 * @param {string} ticker
 * @param {object} book - depth book
 * @param {MicroTickerState} st
 * @param {{ now?: number }} [opts]
 */
export async function maybeLogMicrostructureSignal(pgClient, ticker, book, st, opts = {}) {
  const now = opts.now ?? Date.now();
  const yesTop = topKLevels(book.yes, 1);
  const noTop = topKLevels(book.no, 1);
  if (yesTop.length === 0 || noTop.length === 0) return;

  const bestBid = yesTop[0][0] / 100;
  const bestAsk = (100 - noTop[0][0]) / 100;
  const bidSize = yesTop[0][1];
  const askSize = noTop[0][1];
  if (bidSize + askSize <= 0) return;

  const { mid_cents, spread_cents } = computeMidAndSpread(book);
  if (mid_cents == null || spread_cents == null || spread_cents <= 0) return;

  const mid = mid_cents / 100;
  const spread = spread_cents / 100;
  const microprice = (bestBid * askSize + bestAsk * bidSize) / (bidSize + askSize);
  const imbalance = (bidSize - askSize) / (bidSize + askSize);
  const micropriceEdge = microprice - mid;

  st.midHistory.push({ t: now, mid });
  const cutoff = now - (W.momentum_window_ms ?? 300_000);
  st.midHistory = st.midHistory.filter((x) => x.t >= cutoff);
  let momentum = 0;
  if (st.midHistory.length >= 2) {
    const first = st.midHistory[0].mid;
    momentum = mid - first;
  }

  const crossVenueGap = 0;
  const invSpread = 1 / Math.max(spread, 0.001);
  let confidence =
    (W.w1_microprice_edge ?? 1) * micropriceEdge +
    (W.w2_momentum ?? 0.5) * momentum +
    (W.w3_imbalance_over_spread ?? 0.3) * imbalance * invSpread +
    (W.w4_cross_venue_gap ?? 0.2) * crossVenueGap;

  const topBidVol = bidSize;
  const topAskVol = askSize;
  const liq = Math.min(topBidVol, topAskVol);
  confidence -= (W.liquidity_penalty_coef ?? 0) / Math.max(1, Math.sqrt(liq));
  confidence -= (W.spread_penalty_coef ?? 0) * spread * 100;
  const volProxy = Math.abs(momentum);
  confidence -= (W.vol_penalty_coef ?? 0) * volProxy;

  const maxEdge = W.max_edge ?? 0.04;
  confidence = Math.max(-maxEdge, Math.min(maxEdge, confidence));

  const thresh = W.log_threshold ?? 0.02;
  if (Math.abs(confidence) <= thresh) return;

  const strengthCents = confidence * 100;

  await pgClient.query(
    `
    INSERT INTO pmci.scanner_structural_signals (
      observed_at, market_ticker, signal_strength_cents,
      source_chain_id, detector_track,
      microprice, imbalance_ratio, spread_cents, momentum_signal, confidence_score,
      notes
    ) VALUES (
      now(), $1::text, $2::numeric,
      $3::uuid, 'microstructure',
      $4::numeric, $5::numeric, $6::numeric, $7::numeric, $8::numeric,
      $9::jsonb
    )
    `,
    [
      ticker,
      strengthCents.toFixed(4),
      SOURCE_CHAIN_MICRO,
      microprice.toFixed(6),
      imbalance.toFixed(6),
      String(spread_cents),
      momentum.toFixed(6),
      confidence.toFixed(6),
      JSON.stringify({
        microprice_edge: micropriceEdge,
        threshold: thresh,
        bid_size: bidSize,
        ask_size: askSize,
        cross_venue_gap: crossVenueGap,
      }),
    ],
  );
}

export function createMicrostructureBookState(tickers) {
  /** @type {Map<string, ReturnType<typeof makeEmptyBook>>} */
  const books = new Map();
  /** @type {Map<string, MicroTickerState>} */
  const microSt = new Map();
  /** @type {Map<string, boolean>} */
  const snapshotReceived = new Map();
  for (const t of tickers) {
    books.set(t, makeEmptyBook());
    microSt.set(t, { midHistory: [] });
    snapshotReceived.set(t, false);
  }
  return { books, microSt, snapshotReceived };
}

/**
 * Apply a raw Kalshi WS frame to books (mutates).
 * @param {object} parsed
 * @param {Map<string, ReturnType<typeof makeEmptyBook>>} books
 * @param {Map<string, boolean>} snapshotReceived
 */
export function applyKalshiWsToBooks(parsed, books, snapshotReceived) {
  handleMessage(parsed, books, { info: () => {}, error: () => {}, warn: () => {} }, { snapshotReceived });
}
