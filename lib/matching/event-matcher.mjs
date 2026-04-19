/**
 * Phase G: attach provider_markets to canonical_events (event-first matching).
 */

import { classifyPhaseGSportsMarketType } from "../normalization/market-type-classifier.mjs";
import { classifyTemplate } from "./templates/index.mjs";
import {
  fuzzyTeamNamesMatch,
  sportsDateDeltaDays,
  teamNamesExactMatch,
} from "./sports-helpers.mjs";
import { jaccard, tokenize } from "./scoring.mjs";

/** Below this score, do not attach — route to low-confidence queue (Step 5). */
export const EVENT_ATTACHMENT_MIN_SCORE = 0.5;

/**
 * @param {import('pg').Client} client
 * @param {{ category: string, dateFrom: string, dateTo: string, subcategory?: string }} q
 */
export async function findCanonicalEventsInDateWindow(client, q) {
  if (!client || !q?.category || !q?.dateFrom || !q?.dateTo) return [];
  const params = [q.category, q.dateFrom, q.dateTo];
  let sql = `
    SELECT id, slug, title, category, subcategory, event_date, event_time, participants, external_ref, external_source
    FROM pmci.canonical_events
    WHERE category = $1
      AND event_date IS NOT NULL
      AND event_date >= $2::date
      AND event_date <= $3::date
  `;
  if (q.subcategory) {
    params.push(q.subcategory);
    sql += ` AND subcategory = $4`;
  }
  sql += ` ORDER BY event_date ASC, title ASC`;
  const res = await client.query(sql, params);
  return res.rows ?? [];
}

/**
 * Parse canonical_events.participants into home/away names (TheSportsDB order: away, home when roles missing).
 * @param {unknown} participants
 * @returns {{ home: string, away: string }}
 */
function parseEventHomeAway(participants) {
  const arr = Array.isArray(participants) ? participants : [];
  const withRole = (r) => String(r || "").toLowerCase();
  const homeRows = arr.filter((p) => withRole(p?.role) === "home");
  const awayRows = arr.filter((p) => withRole(p?.role) === "away");
  let home = String(homeRows[0]?.name || "").trim();
  let away = String(awayRows[0]?.name || "").trim();
  if (!home && !away && arr.length >= 2) {
    away = String(arr[0]?.name || "").trim();
    home = String(arr[1]?.name || "").trim();
  }
  return { home, away };
}

function marketAnchorDate(market) {
  const gd = market?.game_date ?? market?.gameDate;
  if (gd != null) {
    return gd instanceof Date ? gd.toISOString().slice(0, 10) : String(gd).slice(0, 10);
  }
  const ct = market?.close_time ?? market?.closeTime;
  if (ct != null) {
    const d = ct instanceof Date ? ct : new Date(ct);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function normSub(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

/**
 * Sports: compare provider home/away to event participants; combine with game vs event date.
 * @param {{ participants?: unknown, event_date?: string | Date, category?: string }} event
 * @param {{ home_team?: string, away_team?: string, game_date?: string | Date, title?: string }} market
 */
function scoreSportsAttachment(event, market) {
  const mh = String(market?.home_team || market?.homeTeam || "").trim();
  const ma = String(market?.away_team || market?.awayTeam || "").trim();
  const { home: eh, away: ea } = parseEventHomeAway(event?.participants);
  if (!mh || !ma || !eh || !ea) return 0;

  const directExact =
    teamNamesExactMatch(mh, eh) && teamNamesExactMatch(ma, ea);
  const swapExact =
    teamNamesExactMatch(mh, ea) && teamNamesExactMatch(ma, eh);
  const directFuzzy =
    fuzzyTeamNamesMatch(mh, eh) && fuzzyTeamNamesMatch(ma, ea);
  const swapFuzzy =
    fuzzyTeamNamesMatch(mh, ea) && fuzzyTeamNamesMatch(ma, eh);

  const exactTeams = directExact || swapExact;
  const fuzzyTeams =
    !exactTeams && (directFuzzy || swapFuzzy);

  if (!exactTeams && !fuzzyTeams) return 0.08;

  const ed = event?.event_date;
  const md = marketAnchorDate(market);
  if (!ed || !md) return 0.12;

  const delta = sportsDateDeltaDays(md, ed);
  if (delta == null) return 0.12;
  if (delta > 1) return 0.25;

  if (exactTeams) {
    if (delta === 0) return 1.0;
    return 0.92;
  }
  if (fuzzyTeams) {
    if (delta === 0) return 0.9;
    return 0.7;
  }
  return 0.1;
}

/**
 * Non-sports: subcategory alignment, date proximity, title token overlap.
 */
function scoreNonSportsAttachment(event, market) {
  const esc = normSub(event?.subcategory);
  const msc = normSub(
    market?.subcategory ?? market?.metadata?.subcategory ?? market?.metadata?.series_subcategory,
  );

  let subScore = 1;
  if (esc && msc) {
    if (esc !== msc) return 0.12;
  } else if (esc || msc) {
    subScore = 0.88;
  }

  const ed = event?.event_date;
  const md = marketAnchorDate(market);
  let dateScore = 0.55;
  if (ed && md) {
    const delta = sportsDateDeltaDays(md, ed);
    if (delta == null) dateScore = 0.5;
    else if (delta === 0) dateScore = 1;
    else if (delta === 1) dateScore = 0.78;
    else dateScore = Math.max(0, 0.5 - delta * 0.08);
  }

  const ta = new Set(tokenize(String(event?.title || "")));
  const tb = new Set(tokenize(String(market?.title || "")));
  const titleSim = jaccard(ta, tb);

  return 0.28 * subScore + 0.32 * dateScore + 0.4 * titleSim;
}

/**
 * Confidence for attaching a provider market row to a canonical event (pure; no DB).
 * Sports: normalized teams vs participants + date. Non-sports: subcategory + date + title Jaccard.
 *
 * @param {{
 *   participants?: unknown,
 *   event_date?: string | Date,
 *   category?: string,
 *   subcategory?: string,
 *   title?: string
 * }} event
 * @param {{
 *   home_team?: string,
 *   away_team?: string,
 *   game_date?: string | Date,
 *   title?: string,
 *   category?: string,
 *   subcategory?: string,
 *   close_time?: string | Date,
 *   metadata?: Record<string, unknown>
 * }} market
 * @returns {number} 0–1; values below {@link EVENT_ATTACHMENT_MIN_SCORE} should not attach.
 */
export function scoreEventAttachment(event, market) {
  const cat = String(event?.category || market?.category || "").toLowerCase();
  if (cat === "sports") return scoreSportsAttachment(event, market);
  return scoreNonSportsAttachment(event, market);
}

/**
 * Phase G classifier: sports use regex-heavy Phase G patterns first, then category router.
 * @param {{ title?: string, category?: string, provider_market_ref?: string, provider_id?: number }} market
 * @returns {{ template: string, params: Record<string, unknown> }}
 */
export function classifyMarketTemplateForSlot(market) {
  const cat = String(market?.category || "").toLowerCase();
  if (cat === "sports") {
    const hit = classifyPhaseGSportsMarketType(market);
    if (hit) return hit;
  }
  const fallback = classifyTemplate(market);
  if (fallback) return fallback;
  return { template: "unknown", params: { source: "event_matcher_fallback" } };
}

/**
 * @param {import('pg').Client} client
 * @param {string} canonicalEventId
 * @param {{ title?: string }} market
 * @param {string} template
 * @param {Record<string, unknown>} templateParams
 */
export async function findOrCreateCanonicalMarketSlot(client, canonicalEventId, market, template, templateParams) {
  const tpJson = JSON.stringify(templateParams ?? {});
  const existing = await client.query(
    `SELECT id FROM pmci.canonical_markets
     WHERE canonical_event_id = $1::uuid
       AND (market_template IS NOT DISTINCT FROM $2)
       AND template_params = $3::jsonb
     LIMIT 1`,
    [canonicalEventId, template, tpJson],
  );
  if (existing.rows?.length) return existing.rows[0].id;

  const label = String(template).slice(0, 240);
  const titleHint = String(market?.title || "").slice(0, 240);
  const ins = await client.query(
    `INSERT INTO pmci.canonical_markets (canonical_event_id, label, market_type, market_template, template_params, title)
     VALUES ($1::uuid, $2, 'binary'::pmci.market_type, $3, $4::jsonb, $5)
     RETURNING id`,
    [canonicalEventId, label, template, tpJson, titleHint || null],
  );
  return ins.rows[0].id;
}

/**
 * @param {import('pg').Client} client
 * @param {{ canonicalMarketId: string, providerMarketId: number, providerId: number, confidence: number, matchMethod?: string }} row
 */
export async function upsertProviderMarketMapRow(client, row) {
  const method = row.matchMethod || "event_attachment";
  await client.query(
    `INSERT INTO pmci.provider_market_map (canonical_market_id, provider_market_id, provider_id, confidence, match_method)
     VALUES ($1::uuid, $2::bigint, $3::smallint, $4::numeric, $5)
     ON CONFLICT (provider_market_id) DO UPDATE SET
       canonical_market_id = EXCLUDED.canonical_market_id,
       confidence = EXCLUDED.confidence,
       match_method = EXCLUDED.match_method`,
    [row.canonicalMarketId, row.providerMarketId, row.providerId, row.confidence, method],
  );
}

/**
 * Score, then if above threshold: classify template, find-or-create canonical_market, write provider_market_map
 * and refresh provider_markets.market_template.
 *
 * @param {import('pg').Client} client
 * @param {{
 *   id: string,
 *   category?: string,
 *   title?: string,
 *   provider_market_ref?: string,
 *   provider_id?: number,
 *   home_team?: string,
 *   away_team?: string,
 *   game_date?: string | Date,
 *   close_time?: string | Date,
 *   subcategory?: string,
 *   metadata?: Record<string, unknown>
 * }} providerMarketRow — pmci.provider_markets row
 * @param {{
 *   id: string,
 *   category?: string,
 *   subcategory?: string,
 *   title?: string,
 *   event_date?: string | Date,
 *   participants?: unknown
 * }} canonicalEventRow
 * @returns {Promise<{ ok: boolean, score: number, canonicalMarketId?: string, reason?: string }>}
 */
export async function attachProviderMarketToCanonicalEvent(client, providerMarketRow, canonicalEventRow) {
  const score = scoreEventAttachment(canonicalEventRow, providerMarketRow);
  if (score < EVENT_ATTACHMENT_MIN_SCORE) {
    return { ok: false, score, reason: "low_confidence" };
  }

  const { template, params } = classifyMarketTemplateForSlot({
    title: providerMarketRow?.title,
    category: providerMarketRow?.category,
    provider_market_ref: providerMarketRow?.provider_market_ref,
    provider_id: providerMarketRow?.provider_id,
  });

  const canonicalMarketId = await findOrCreateCanonicalMarketSlot(
    client,
    canonicalEventRow.id,
    providerMarketRow,
    template,
    params,
  );

  await client.query(
    `UPDATE pmci.provider_markets
     SET market_template = $2,
         template_params = $3::jsonb
     WHERE id = $1::bigint`,
    [providerMarketRow.id, template, JSON.stringify(params ?? {})],
  );

  await upsertProviderMarketMapRow(client, {
    canonicalMarketId,
    providerMarketId: Number(providerMarketRow.id),
    providerId: Number(providerMarketRow.provider_id),
    confidence: score,
    matchMethod: "event_attachment",
  });

  return { ok: true, score, canonicalMarketId };
}

/** Exported for auto-linker / ingestion: calendar date string or null. */
export function getMarketAnchorDate(market) {
  return marketAnchorDate(market);
}
