/**
 * NBA informational-lag detector (scanner-plan-v1 §5.1).
 * Uses provider_market_snapshots; inserts pmci.scanner_informational_lag_signals on full gate pass.
 */

import {
  computeWpaMagnitude,
  isHighLeverageActionType,
  liveHomeWinProb,
} from "../../../lib/scanner/hoopR-lite.mjs";

const SOURCE_CHAIN_NBA =
  process.env.SOURCE_CHAIN_NBA?.trim() || "aaaa1111-e89b-12d3-a456-426614174000";

const STABILITY_THRESH = Number(process.env.SCANNER_NBA_MID_MOVE_THRESH ?? 0.005) || 0.005;
const DIVERGENCE_THRESH = Number(process.env.SCANNER_NBA_DIVERGENCE_THRESH ?? 0.03) || 0.03;
const DEFAULT_TTL_SEC = Math.max(30, Number(process.env.SCANNER_NBA_TTL_SECONDS ?? 90) || 90);
const P75_WINDOW_CAP = Math.min(50_000, Math.max(100, Number(process.env.SCANNER_NBA_P75_WINDOW ?? 8000) || 8000));

/** Rolling |WPA| magnitudes for p75 gate */
export class WpaRollingP75 {
  constructor() {
    /** @type {number[]} */
    this.buf = [];
  }
  /** @param {number} x */
  push(x) {
    const ax = Math.abs(x);
    if (!Number.isFinite(ax)) return;
    this.buf.push(ax);
    if (this.buf.length > P75_WINDOW_CAP) this.buf.splice(0, this.buf.length - P75_WINDOW_CAP);
  }
  p75() {
    if (this.buf.length < 20) return 0;
    const s = [...this.buf].sort((a, b) => a - b);
    const i = Math.floor(0.75 * (s.length - 1));
    return s[i] ?? 0;
  }
}

/**
 * @param {import("pg").Client} client
 * @param {string} gameId
 * @returns {Promise<{ ticker: string, yes_is_home: boolean } | null>}
 */
export async function lookupKalshiMarketForGame(client, gameId) {
  const gid = String(gameId);
  const r = await client.query(
    `
    SELECT
      pm.provider_market_ref AS ticker,
      COALESCE((pm.template_params->>'nba_yes_is_home')::boolean, true) AS yes_is_home
    FROM pmci.provider_markets pm
    JOIN pmci.providers pr ON pr.id = pm.provider_id AND pr.code = 'kalshi'
    WHERE
      (pm.template_params->>'nba_canonical_game_id') = $1
      OR (pm.template_params->>'nba_game_id') = $1
      OR (pm.template_params->>'game_id_nba_stats') = $1
    ORDER BY pm.last_seen_at DESC NULLS LAST
    LIMIT 1
    `,
    [gid],
  );
  if (!r.rows?.length) return null;
  return { ticker: String(r.rows[0].ticker), yes_is_home: r.rows[0].yes_is_home !== false };
}

/**
 * YES mid in [0,1] at or before `atIso`.
 * @param {import("pg").Client} client
 * @param {string} ticker
 * @param {string} atIso
 */
export async function kalshiMidAtOrBefore(client, ticker, atIso) {
  const r = await client.query(
    `
    SELECT
      COALESCE(
        (s.best_bid_yes + s.best_ask_yes) / 2,
        s.price_yes
      )::numeric AS mid
    FROM pmci.provider_market_snapshots s
    JOIN pmci.provider_markets pm ON pm.id = s.provider_market_id
    WHERE pm.provider_market_ref = $1
      AND s.observed_at <= $2::timestamptz
    ORDER BY s.observed_at DESC
    LIMIT 1
    `,
    [ticker, atIso],
  );
  const v = r.rows[0]?.mid;
  return v != null ? Number(v) : null;
}

export function extractActionsFromNbaJson(json) {
  const game = json?.game;
  const raw = json?.game?.actions ?? json?.actions ?? game?.plays ?? [];
  return Array.isArray(raw) ? raw : [];
}

/**
 * @param {object} action
 */
export function actionEventIso(action) {
  const iso =
    action?.timeActual ??
    action?.time ??
    action?.clock ??
    action?.actionTime ??
    null;
  if (iso && typeof iso === "string" && /^\d{4}-\d{2}-\d{2}T/.test(iso)) return iso;
  return new Date().toISOString();
}

function shiftIso(baseIso, sec) {
  const t = Date.parse(baseIso);
  if (!Number.isFinite(t)) return new Date(Date.now() + sec * 1000).toISOString();
  return new Date(t + sec * 1000).toISOString();
}

function scoreboardFromActions(actions, upToIndex) {
  let home = 0;
  let away = 0;
  let period = 1;
  const slice = actions.slice(0, upToIndex + 1);
  for (const a of slice) {
    if (a?.scoreHome != null) home = Number(a.scoreHome) || home;
    if (a?.scoreAway != null) away = Number(a.scoreAway) || away;
    if (a?.period != null) period = Number(a.period) || period;
  }
  return { homeScore: home, awayScore: away, period };
}

/**
 * Process new actions since lastIndex (exclusive). Mutates rolling p75 with |wpa|.
 * @param {object} p
 */
export async function processNbaPlayByPlayDigest(p) {
  const {
    pgClient,
    gameId,
    json,
    rollingP75,
    lastProcessedIndex = -1,
    markProcessed,
  } = p;

  const actions = extractActionsFromNbaJson(json);
  if (!actions.length) return;

  const market = await lookupKalshiMarketForGame(pgClient, gameId);
  if (!market) {
    console.warn(`[nba-lag] no Kalshi market mapping for NBA game_id=${gameId} — skip detector`);
    markProcessed?.(actions.length - 1);
    return;
  }

  const { ticker, yes_is_home: yesIsHome } = market;

  for (let i = lastProcessedIndex + 1; i < actions.length; i++) {
    const action = actions[i];
    const actionType = String(action?.actionType ?? action?.subType ?? "");
    if (!isHighLeverageActionType(actionType)) continue;

    const wpaMag = computeWpaMagnitude(actionType);
    rollingP75.push(wpaMag);

    if (rollingP75.buf.length >= 20 && wpaMag < rollingP75.p75()) continue;

    const postState = scoreboardFromActions(actions, i);
    const fairHome = liveHomeWinProb(postState);
    const fairWp = yesIsHome ? fairHome : 1 - fairHome;

    const evIso = actionEventIso(action);
    const midPre = await kalshiMidAtOrBefore(pgClient, ticker, shiftIso(evIso, -1));
    const midPost30 = await kalshiMidAtOrBefore(pgClient, ticker, shiftIso(evIso, 30));

    if (midPre == null || midPost30 == null) continue;
    if (Math.abs(midPost30 - midPre) >= STABILITY_THRESH) continue;

    if (Math.abs(fairWp - midPost30) <= DIVERGENCE_THRESH) continue;

    const divergence = Math.abs(fairWp - midPost30);
    const strengthCents = divergence * 100;

    const notes = {
      stream_b: "nba_informational_lag_v1",
      wpa_magnitude: wpaMag,
      wpa_p75_used: rollingP75.p75(),
      actionType,
      actionNumber: action?.actionNumber ?? i,
      yes_is_home: yesIsHome,
    };

    await pgClient.query(
      `
        INSERT INTO pmci.scanner_informational_lag_signals (
          observed_at,
          market_ticker,
          signal_strength_cents,
          source_chain_id,
          game_id,
          period,
          game_clock_seconds_remaining,
          event_type,
          wpa_at_event,
          wpa_percentile_30d,
          pre_event_kalshi_mid,
          post_event_kalshi_mid,
          fair_wp_estimate,
          divergence_at_t_plus_30s,
          external_event_at,
          notes
        ) VALUES (
          now(),
          $1::text,
          $2::numeric,
          $3::uuid,
          $4::text,
          $5::int,
          NULL,
          $6::text,
          $7::numeric,
          $8::numeric,
          $9::numeric,
          $10::numeric,
          $11::numeric,
          $12::numeric,
          $13::timestamptz,
          $14::jsonb
        )
      `,
      [
        ticker,
        strengthCents.toFixed(4),
        SOURCE_CHAIN_NBA,
        String(gameId),
        postState.period,
        actionType,
        wpaMag.toFixed(6),
        rollingP75.p75().toFixed(6),
        midPre,
        midPost30,
        fairWp,
        divergence,
        evIso,
        JSON.stringify(notes),
      ],
    );
    console.log(
      `[nba-lag] SIGNAL game=${gameId} ticker=${ticker} div=${divergence.toFixed(4)} wpa=${wpaMag.toFixed(4)}`,
    );
  }

  markProcessed?.(actions.length - 1);
}

/**
 * @param {import("pg").Client} client
 */
export async function resolveAgedInformationalLagSignals(client) {
  const ttl = DEFAULT_TTL_SEC;
  const r = await client.query(
    `
    SELECT signal_id, market_ticker, observed_at, fair_wp_estimate, post_event_kalshi_mid,
           notes
    FROM pmci.scanner_informational_lag_signals
    WHERE resolved_at IS NULL
      AND observed_at < now() - (($1::int + 60) * interval '1 second')
    LIMIT 500
    `,
    [ttl],
  );

  for (const row of r.rows) {
    const observedAt = row.observed_at;
    const signalId = row.signal_id;
    const ticker = row.market_ticker;
    const fair = row.fair_wp_estimate != null ? Number(row.fair_wp_estimate) : null;
    const midPost = row.post_event_kalshi_mid != null ? Number(row.post_event_kalshi_mid) : null;

    const resolveAt = new Date(observedAt.getTime() + ttl * 1000).toISOString();
    const midRes = await kalshiMidAtOrBefore(client, ticker, resolveAt);

    let outcome = "no_signal";
    let pnlCents = 0;

    if (midRes == null || midPost == null || fair == null) {
      outcome = "timeout";
    } else {
      const delta = midRes - midPost;
      const predictedUp = fair > midPost;
      const movedUp = delta >= 0.01;
      const movedDown = delta <= -0.01;
      if (predictedUp && movedUp) outcome = "hit";
      else if (!predictedUp && movedDown) outcome = "hit";
      else if (Math.abs(delta) < 0.01) outcome = "miss";
      else outcome = "miss";
      pnlCents = delta * 100;
    }

    await client.query(
      `
      UPDATE pmci.scanner_informational_lag_signals
      SET resolved_at = now(),
          resolved_outcome = $2::text,
          resolved_pnl_cents = $3::numeric
      WHERE signal_id = $1::uuid
      `,
      [signalId, outcome, pnlCents.toFixed(4)],
    );
  }

  return { resolved: r.rows.length };
}
