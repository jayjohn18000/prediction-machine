/**
 * A5 backtest engine: hourly-sampled entry detection, cross-venue arb
 * construction, hold to resolution. Emits one FixtureRow per linked bilateral
 * family (including skip rows); aggregation into the scoreboard happens
 * downstream in aggregate.mjs.
 *
 * Snapshot time series: pmci.provider_market_snapshots (verified from
 * supabase/migrations/20260225000001_pmci_init.sql).
 *
 * @typedef {import('./types.mjs').FixtureRow} FixtureRow
 */
import { arbTrade, PREMIUM_PER_TRADE_USD, VOID_REFUND_MODEL } from "./arb-trade.mjs";
import { templateOf } from "./template.mjs";

const SNAPSHOT_TABLE = "pmci.provider_market_snapshots";
const V_LINK = "pmci.v_market_links_current";
const DEFAULT_ENTRY_THRESHOLD = 0.01;
const ENGINE_VERSION = "arb-v1";

/**
 * @param {object} params
 * @param {import('pg').Client} params.pg
 * @param {Map<string, { classification: string, family_id: string }>} params.a3ByFamily
 * @param {number} [params.intervalMs] - default 3600_000 (hourly)
 * @param {number} [params.entryThresholdAbs] - e.g. 0.01
 * @param {Set<string>} [params.excludeFamilyIds]
 * @returns {Promise<{ rows: FixtureRow[], config: object }>}
 */
export async function runBacktestEngine(params) {
  const {
    pg: client,
    a3ByFamily,
    intervalMs = 60 * 60 * 1000,
    entryThresholdAbs = DEFAULT_ENTRY_THRESHOLD,
    excludeFamilyIds = new Set(),
  } = params;

  const famRows = await loadBilateralFamilies(client, a3ByFamily, excludeFamilyIds);
  const out = [];
  for (const fam of famRows) {
    const r = await simulateOneFamily(client, {
      fam,
      intervalMs,
      entryThresholdAbs,
    });
    out.push(r);
  }
  // Deterministic ordering: template_id ASC, family_id ASC. The script may
  // re-sort for CSV output; engine-level determinism is preserved here.
  out.sort((a, b) => {
    const t = String(a.template_id).localeCompare(String(b.template_id));
    if (t !== 0) return t;
    return String(a.family_id).localeCompare(String(b.family_id), "en", { numeric: true });
  });
  return {
    rows: out,
    config: {
      snapshot_table: SNAPSHOT_TABLE,
      entry_threshold_abs: entryThresholdAbs,
      interval_ms: intervalMs,
      premium_per_trade_usd: PREMIUM_PER_TRADE_USD,
      engine_version: ENGINE_VERSION,
      void_refund_model: VOID_REFUND_MODEL,
    },
  };
}

async function loadBilateralFamilies(client, a3ByFamily, excludeFamilyIds) {
  const sql = `
    WITH bilateral AS (
      SELECT c.family_id
      FROM ${V_LINK} c
      JOIN pmci.provider_markets pm ON pm.id = c.provider_market_id
      WHERE c.status = 'active' AND (pm.category = 'sports' OR pm.category IS NULL)
      GROUP BY c.family_id
      HAVING COUNT(*) = 2 AND COUNT(DISTINCT c.provider_id) = 2
    )
    SELECT
      bf.family_id::text AS family_id,
      COALESCE(pm.category, 'sports') AS category,
      pr.code AS provider_code,
      pm.sport AS pm_sport,
      to_jsonb(pm) AS market_json
    FROM bilateral bf
    JOIN ${V_LINK} v ON v.family_id = bf.family_id AND v.status = 'active'
    JOIN pmci.provider_markets pm ON pm.id = v.provider_market_id
    JOIN pmci.providers pr ON pr.id = pm.provider_id
    WHERE pr.code IN ('kalshi', 'polymarket')
    ORDER BY bf.family_id::text, pr.code
  `;
  const res = await client.query(sql);
  const byFamily = new Map();
  for (const row of res.rows) {
    const fid = String(row.family_id);
    if (excludeFamilyIds.has(fid)) continue;
    if (a3ByFamily && !a3ByFamily.has(fid)) continue;
    if (!byFamily.has(fid)) {
      byFamily.set(fid, {
        family_id: fid,
        sport: row.pm_sport || null,
        k_sport: null,
        p_sport: null,
        category: row.category,
        resolution_equivalence: a3ByFamily?.get(fid)?.classification ?? "equivalent",
        kalshi: null,
        poly: null,
      });
    }
    const slot = byFamily.get(fid);
    const j = row.market_json;
    if (row.provider_code === "kalshi") {
      slot.kalshi = { ...j, provider: "kalshi" };
      slot.k_sport = row.pm_sport ?? j?.sport ?? null;
    }
    if (row.provider_code === "polymarket") {
      slot.poly = { ...j, provider: "polymarket" };
      slot.p_sport = row.pm_sport ?? j?.sport ?? null;
    }
  }
  const out = [];
  for (const s of byFamily.values()) {
    if (s.kalshi?.id == null || s.poly?.id == null) continue;
    // Prefer per-leg sport (from provider_markets) over the family-level sport.
    if (!s.sport) s.sport = s.k_sport || s.p_sport || null;
    out.push(s);
  }
  return out;
}

/**
 * @param {import('pg').Client} client
 * @param {object} ctx
 * @returns {Promise<FixtureRow>}
 */
async function simulateOneFamily(client, { fam, intervalMs, entryThresholdAbs }) {
  const tmpl = templateOf(fam);
  const baseStamp = {
    family_id: fam.family_id,
    template_id: tmpl.template_id,
    template_label: tmpl.template_label,
    category: tmpl.category,
    template_include_in_scoreboard: tmpl.include_in_scoreboard,
    sport: fam.sport || null,
    resolution_equivalence: fam.resolution_equivalence,
    entry_threshold_used: entryThresholdAbs,
    snapshot_interval_ms: intervalMs,
    void_refund_model: VOID_REFUND_MODEL,
  };
  const skipRow = (reason) => ({
    ...baseStamp,
    skip: reason,
    direction: null,
    spread_at_entry: null,
    cheap_state: null,
    exp_state: null,
    gross_dollars: null,
    net_dollars: null,
    hold_days: null,
    cheap_costs_breakdown: null,
    exp_costs_breakdown: null,
  });

  const kId = Number(fam.kalshi.id);
  const pId = Number(fam.poly.id);

  const oSql = `
    SELECT provider_market_id, winning_outcome, resolved_at
    FROM pmci.market_outcomes
    WHERE provider_market_id = ANY($1::bigint[])
  `;
  const orows = (await client.query(oSql, [[kId, pId]])).rows;
  const ok = orows.find((r) => Number(r.provider_market_id) === kId);
  const op = orows.find((r) => Number(r.provider_market_id) === pId);
  if (!ok || !op) return skipRow("outcomes_missing");
  if (!ok.resolved_at || !op.resolved_at) return skipRow("outcomes_missing");

  const sSql = `
    SELECT provider_market_id, observed_at, price_yes::float8 AS price_yes
    FROM ${SNAPSHOT_TABLE}
    WHERE provider_market_id = ANY($1::bigint[])
      AND price_yes IS NOT NULL
      AND price_yes > 0 AND price_yes < 1
    ORDER BY provider_market_id, observed_at ASC
  `;
  const srows = (await client.query(sSql, [[kId, pId]])).rows;
  const byK = srows.filter((r) => Number(r.provider_market_id) === kId);
  const byP = srows.filter((r) => Number(r.provider_market_id) === pId);
  if (byK.length === 0 || byP.length === 0) return skipRow("degenerate_prices");

  const tStart = Math.max(
    new Date(byK[0].observed_at).getTime(),
    new Date(byP[0].observed_at).getTime(),
  );
  // Entry-search runs to the ingestion window end — NOT min of resolved_at.
  // Using the last snapshot timestamp keeps late-window entry opportunities
  // in scope when one leg resolved earlier than the other.
  const tEnd = Math.max(
    new Date(byK[byK.length - 1].observed_at).getTime(),
    new Date(byP[byP.length - 1].observed_at).getTime(),
  );
  if (!Number.isFinite(tEnd) || tEnd <= tStart) return skipRow("degenerate_prices");

  let entryTime = null;
  let kPrice = null;
  let pPrice = null;
  for (let t = Math.ceil(tStart / intervalMs) * intervalMs; t <= tEnd; t += intervalMs) {
    const k = lastSnapshotAtOrBefore(byK, t);
    const p = lastSnapshotAtOrBefore(byP, t);
    if (!k || !p) continue;
    const K = Number(k.price_yes);
    const Pv = Number(p.price_yes);
    if (K <= 0 || K >= 1 || Pv <= 0 || Pv >= 1) continue;
    if (Math.abs(K - Pv) >= entryThresholdAbs) {
      entryTime = t;
      kPrice = K;
      pPrice = Pv;
      break;
    }
  }
  if (entryTime == null) return skipRow("no_entry_found");

  const holdMsEnd = Math.max(
    new Date(ok.resolved_at).getTime(),
    new Date(op.resolved_at).getTime(),
  );
  const holdDays = Math.max(0, Math.ceil((holdMsEnd - entryTime) / 86400000));

  const trade = arbTrade({
    kYesAtEntry: kPrice,
    pYesAtEntry: pPrice,
    kalshiMarket: fam.kalshi,
    polyMarket: fam.poly,
    kalshiWinningOutcome: ok.winning_outcome,
    polyWinningOutcome: op.winning_outcome,
    holdDays,
    entryThresholdAbs,
    snapshotIntervalMs: intervalMs,
  });

  return {
    ...baseStamp,
    skip: null,
    direction: trade.direction,
    spread_at_entry: trade.spread_at_entry,
    cheap_state: trade.cheap_state,
    exp_state: trade.exp_state,
    gross_dollars: trade.gross_dollars,
    net_dollars: trade.net_dollars,
    hold_days: trade.hold_days,
    cheap_costs_breakdown: trade.cheap_costs_breakdown,
    exp_costs_breakdown: trade.exp_costs_breakdown,
  };
}

/**
 * @param {Array<{ observed_at: Date|string, price_yes: number }>} sorted
 * @param {number} tMs
 */
function lastSnapshotAtOrBefore(sorted, tMs) {
  let lo = 0;
  let hi = sorted.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const tm = new Date(sorted[mid].observed_at).getTime();
    if (tm <= tMs) {
      best = sorted[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export { SNAPSHOT_TABLE, DEFAULT_ENTRY_THRESHOLD, ENGINE_VERSION };
