/**
 * Phase G: event-first attachment + bilateral market_links for the spread observer frontier.
 * @see docs/plans/phase-g-canonical-events-plan.md Step 6
 */

import {
  attachProviderMarketToCanonicalEvent,
  EVENT_ATTACHMENT_MIN_SCORE,
  findCanonicalEventsInDateWindow,
  getMarketAnchorDate,
  scoreEventAttachment,
} from "./event-matcher.mjs";

const LEAGUE_SUBCATEGORIES = new Set(["nba", "nhl", "mlb", "mls", "epl", "soccer"]);

function addCalendarDays(isoDateStr, deltaDays) {
  const d = new Date(`${isoDateStr}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function leagueSubcategoryFromMarket(market) {
  const s = String(market?.sport || "").toLowerCase();
  if (LEAGUE_SUBCATEGORIES.has(s)) return s;
  return null;
}

/**
 * @param {import('pg').Client} client
 * @param {object} market — pmci.provider_markets row
 * @param {{ minScore?: number }} [opts]
 */
export async function findBestCanonicalEventForMarket(client, market, opts = {}) {
  const minScore = opts.minScore ?? Number(process.env.PMCI_AUTO_LINK_MIN_SCORE ?? EVENT_ATTACHMENT_MIN_SCORE);
  const category = String(market?.category || "").trim();
  if (!category) return null;

  const anchor = getMarketAnchorDate(market);
  if (!anchor) return null;

  const dateFrom = addCalendarDays(anchor, -1);
  const dateTo = addCalendarDays(anchor, 1);
  const sub = leagueSubcategoryFromMarket(market);

  let candidates = await findCanonicalEventsInDateWindow(client, {
    category,
    dateFrom,
    dateTo,
    subcategory: sub || undefined,
  });
  if ((!candidates || candidates.length === 0) && sub) {
    candidates = await findCanonicalEventsInDateWindow(client, {
      category,
      dateFrom,
      dateTo,
    });
  }
  if (!candidates?.length) return null;

  let best = null;
  let bestScore = -1;
  for (const ev of candidates) {
    const s = scoreEventAttachment(ev, market);
    if (s > bestScore) {
      bestScore = s;
      best = ev;
    }
  }
  if (!best || bestScore < minScore) return null;
  return { event: best, score: bestScore };
}

async function getFamilyIdIfLinked(client, providerMarketId) {
  const r = await client.query(
    `SELECT family_id FROM pmci.v_market_links_current WHERE provider_market_id = $1::bigint LIMIT 1`,
    [providerMarketId],
  );
  return r.rows?.[0]?.family_id != null ? Number(r.rows[0].family_id) : null;
}

async function getNextLinkerVersion(client) {
  const r = await client.query(`SELECT coalesce(max(version), 0) + 1 AS v FROM pmci.linker_runs`);
  return Number(r.rows?.[0]?.v ?? 1);
}

async function insertMarketLinkRow(client, args) {
  const {
    familyId,
    providerId,
    providerMarketId,
    linkVersion,
    confidence,
    reasons,
  } = args;
  const reasonsJson = JSON.stringify(reasons ?? {});
  await client.query(
    `INSERT INTO pmci.market_links (
       family_id, provider_id, provider_market_id, relationship_type, status,
       link_version, confidence,
       correlation_window, lag_seconds, correlation_strength,
       break_rate, last_validated_at, staleness_score,
       reasons
     ) VALUES (
       $1, $2, $3, 'equivalent'::pmci.relationship_type, 'active',
       $4, $5,
       NULL, NULL, NULL, NULL, NULL, NULL,
       $6::jsonb
     )
     ON CONFLICT (family_id, provider_market_id, link_version)
     DO UPDATE SET
       relationship_type = EXCLUDED.relationship_type,
       status = EXCLUDED.status,
       confidence = EXCLUDED.confidence,
       reasons = EXCLUDED.reasons,
       updated_at = now()`,
    [familyId, providerId, providerMarketId, linkVersion, confidence, reasonsJson],
  );
}

/**
 * For one canonical_market slot: if there is exactly one Kalshi + one Polymarket leg and neither
 * market is already in an incompatible active link, ensure a family + two equivalent links.
 *
 * @returns {Promise<number>} 1 if a new bilateral pair was written this call, 0 otherwise
 */
export async function ensureBilateralLinksForCanonicalMarketSlot(client, canonicalMarketId) {
  const legsRes = await client.query(
    `SELECT pmm.provider_market_id, pmm.provider_id, pmm.confidence, pr.code AS provider_code
     FROM pmci.provider_market_map pmm
     JOIN pmci.providers pr ON pr.id = pmm.provider_id
     WHERE pmm.canonical_market_id = $1::uuid
       AND pmm.removed_at IS NULL
       AND (pmm.status IS NULL OR pmm.status = 'active')`,
    [canonicalMarketId],
  );
  const legs = legsRes.rows || [];
  const byCode = new Map();
  for (const row of legs) {
    const code = String(row.provider_code || "").toLowerCase();
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(row);
  }
  const kalshiRows = byCode.get("kalshi") || [];
  const polyRows = byCode.get("polymarket") || [];
  if (kalshiRows.length !== 1 || polyRows.length !== 1) return 0;

  const k = kalshiRows[0];
  const p = polyRows[0];
  const kId = Number(k.provider_market_id);
  const pId = Number(p.provider_market_id);

  const famK = await getFamilyIdIfLinked(client, kId);
  const famP = await getFamilyIdIfLinked(client, pId);
  if (famK != null && famP != null) {
    if (famK === famP) return 0;
    return 0;
  }
  if (famK != null || famP != null) return 0;

  const cmRes = await client.query(
    `SELECT cm.id, cm.canonical_event_id, cm.market_template
     FROM pmci.canonical_markets cm
     WHERE cm.id = $1::uuid`,
    [canonicalMarketId],
  );
  const cm = cmRes.rows?.[0];
  if (!cm) return 0;

  let familyId;
  const existingFam = await client.query(
    `SELECT id FROM pmci.market_families WHERE canonical_market_id = $1::uuid LIMIT 1`,
    [canonicalMarketId],
  );
  if (existingFam.rows?.length) {
    familyId = Number(existingFam.rows[0].id);
  } else {
    const label = `phase_g::cm::${canonicalMarketId}`;
    const notes = "auto-linker: bilateral equivalent from shared canonical_market slot";
    const ins = await client.query(
      `INSERT INTO pmci.market_families (label, notes, canonical_event_id, canonical_market_id)
       VALUES ($1, $2, $3::uuid, $4::uuid)
       RETURNING id`,
      [label, notes, cm.canonical_event_id, canonicalMarketId],
    );
    familyId = Number(ins.rows[0].id);
  }

  const already = await client.query(
    `SELECT count(DISTINCT provider_market_id)::int AS c
     FROM pmci.v_market_links_current
     WHERE family_id = $1 AND provider_market_id = ANY($2::bigint[])`,
    [familyId, [kId, pId]],
  );
  if (Number(already.rows?.[0]?.c ?? 0) >= 2) return 0;

  const version = await getNextLinkerVersion(client);
  await client.query(`INSERT INTO pmci.linker_runs (version, description) VALUES ($1, $2)`, [
    version,
    "phase_g auto-linker bilateral",
  ]);

  const conf = Math.min(Number(k.confidence ?? 1), Number(p.confidence ?? 1));
  const reasons = {
    source: "phase_g_auto_linker",
    canonical_market_id: canonicalMarketId,
    market_template: cm.market_template,
  };

  await insertMarketLinkRow(client, {
    familyId,
    providerId: Number(k.provider_id),
    providerMarketId: kId,
    linkVersion: version,
    confidence: conf,
    reasons,
  });
  await insertMarketLinkRow(client, {
    familyId,
    providerId: Number(p.provider_id),
    providerMarketId: pId,
    linkVersion: version,
    confidence: conf,
    reasons,
  });

  return 1;
}

/**
 * Phase G bugfix 2026-04-19: interleave providers so a large batch does not become
 * Kalshi-dominated (prior observed ratio ~55:1 Kalshi:Polymarket). Additionally,
 * prioritize H2H-ready rows (home/away/game_date all non-null) so the pass spends its
 * serial scoring loop on rows that can actually attach to a canonical_event — otherwise
 * the batch fills with null-team rows that always skip.
 *
 * Priority (lowest sort-value first):
 *   1. H2H-ready inside league subcategory
 *   2. H2H-ready outside league subcategory
 *   3. Anything else
 * Within each tier: per-provider round-robin + recency.
 */
const SQL_UNMAPPED = `
  WITH ranked AS (
    SELECT pm.*, pr.code AS provider_code,
      CASE
        WHEN pm.home_team IS NOT NULL AND pm.away_team IS NOT NULL AND pm.game_date IS NOT NULL THEN 0
        ELSE 1
      END AS h2h_tier,
      CASE
        WHEN lower(coalesce(pm.sport, '')) IN ('mlb', 'nba', 'nhl', 'mls', 'epl', 'soccer') THEN 0
        ELSE 1
      END AS league_tier,
      ROW_NUMBER() OVER (
        PARTITION BY pm.provider_id,
          CASE
            WHEN pm.home_team IS NOT NULL AND pm.away_team IS NOT NULL AND pm.game_date IS NOT NULL THEN 0
            ELSE 1
          END
        ORDER BY
          CASE WHEN lower(coalesce(pm.sport, '')) IN ('mlb', 'nba', 'nhl', 'mls', 'epl', 'soccer') THEN 0 ELSE 1 END,
          pm.last_seen_at DESC NULLS LAST,
          pm.id DESC
      ) AS provider_rank
    FROM pmci.provider_markets pm
    JOIN pmci.providers pr ON pr.id = pm.provider_id
    LEFT JOIN pmci.provider_market_map pmm ON pmm.provider_market_id = pm.id
    WHERE pmm.id IS NULL
      AND (pm.status IS NULL OR pm.status IN ('active', 'open'))
  )
  SELECT *
  FROM ranked
  ORDER BY
    h2h_tier ASC,
    provider_rank ASC,
    league_tier ASC,
    last_seen_at DESC NULLS LAST,
    id DESC
  LIMIT $1
`;

/**
 * One pass: attach unmapped markets to canonical events, then wire Kalshi↔Polymarket bilateral links.
 *
 * @param {import('pg').Client} client
 * @param {{ limit?: number, minScore?: number }} [opts]
 * @returns {Promise<{ attached: number, skipped: number, linked: number, candidates: number }>}
 */
export async function runAutoLinkPass(client, opts = {}) {
  if (!client) return { attached: 0, skipped: 0, linked: 0, candidates: 0 };
  const limit = opts.limit ?? Number(process.env.PMCI_AUTO_LINK_BATCH ?? "500");
  const minScore = opts.minScore ?? Number(process.env.PMCI_AUTO_LINK_MIN_SCORE ?? EVENT_ATTACHMENT_MIN_SCORE);

  const { rows: unmapped } = await client.query(SQL_UNMAPPED, [limit]);

  let attached = 0;
  let skipped = 0;
  let candidates = 0;

  for (const row of unmapped) {
    const hit = await findBestCanonicalEventForMarket(client, row, { minScore });
    if (!hit) {
      skipped += 1;
      continue;
    }
    candidates += 1;
    const att = await attachProviderMarketToCanonicalEvent(client, row, hit.event);
    if (!att.ok) {
      skipped += 1;
      continue;
    }
    attached += 1;
  }

  const slotRes = await client.query(
    `SELECT pmm.canonical_market_id
     FROM pmci.provider_market_map pmm
     WHERE pmm.removed_at IS NULL
       AND (pmm.status IS NULL OR pmm.status = 'active')
     GROUP BY pmm.canonical_market_id
     HAVING count(DISTINCT pmm.provider_id) >= 2`,
  );

  let linked = 0;
  for (const r of slotRes.rows || []) {
    const n = await ensureBilateralLinksForCanonicalMarketSlot(client, r.canonical_market_id);
    linked += n;
  }

  return { attached, skipped, linked, candidates, examined: unmapped.length };
}
