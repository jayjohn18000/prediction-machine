#!/usr/bin/env node
/**
 * Phase G Step 7: migrate existing bilateral market_families into canonical_events +
 * provider_event_map + provider_market_map, then run auto-link pass + validation report.
 *
 * Env: DATABASE_URL
 * Optional:
 *   PHASE7_DRY_RUN=1 — no writes
 *   PHASE7_SKIP_AUTO_LINK=1 — migrate + report only (default); set to 0 to run runAutoLinkPass on unmapped markets (can take hours at 37K scale)
 *   PMCI_AUTO_LINK_BATCH — batch size when auto-link runs (default 50000)
 *
 * @see docs/plans/phase-g-canonical-events-plan.md Step 7
 */
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";
import { kalshiProviderEventRefFromMarket } from "../../lib/kalshi/kalshi-series.mjs";
import {
  classifyMarketTemplateForSlot,
  findOrCreateCanonicalMarketSlot,
  upsertProviderMarketMapRow,
} from "../../lib/matching/event-matcher.mjs";
import { runAutoLinkPass } from "../../lib/matching/auto-linker.mjs";

loadEnv();

function extractPolyEventSlug(pm) {
  const er = pm.event_ref != null ? String(pm.event_ref) : "";
  const hash = er.indexOf("#");
  if (hash > 0) return er.slice(0, hash).trim();
  if (er.trim()) return er.trim();
  return "";
}

async function countBilateralFamilies(client) {
  const r = await client.query(`
    SELECT count(*)::int AS n
    FROM (
      SELECT family_id
      FROM pmci.v_market_links_current
      GROUP BY family_id
      HAVING count(DISTINCT provider_id) >= 2
    ) t
  `);
  return Number(r.rows?.[0]?.n ?? 0);
}

async function loadFamilyIds(client) {
  const r = await client.query(`
    SELECT family_id
    FROM pmci.v_market_links_current
    GROUP BY family_id
    HAVING count(DISTINCT provider_id) >= 2
    ORDER BY family_id
  `);
  return (r.rows || []).map((x) => Number(x.family_id));
}

async function linkRateByCategory(client) {
  return client.query(`
    SELECT
      coalesce(lower(trim(pm.category)), '(null)') AS category,
      count(*)::bigint AS total_active,
      count(*) FILTER (WHERE ml.provider_market_id IS NOT NULL)::bigint AS linked_spread
    FROM pmci.provider_markets pm
    LEFT JOIN pmci.v_market_links_current ml ON ml.provider_market_id = pm.id
    WHERE pm.status IS NULL OR pm.status IN ('active', 'open')
    GROUP BY 1
    ORDER BY total_active DESC
  `);
}

async function attachmentStats(client) {
  const r = await client.query(`
    SELECT
      (SELECT count(*)::bigint FROM pmci.canonical_events) AS canonical_events,
      (SELECT count(*)::bigint FROM pmci.provider_event_map) AS provider_event_maps,
      (SELECT count(*)::bigint FROM pmci.provider_market_map WHERE removed_at IS NULL) AS provider_market_maps
  `);
  return r.rows?.[0] ?? {};
}

async function migrateOneFamily(client, familyId, dryRun) {
  const links = await client.query(
    `SELECT ml.provider_market_id, ml.provider_id, pr.code AS provider_code
     FROM pmci.v_market_links_current ml
     JOIN pmci.providers pr ON pr.id = ml.provider_id
     WHERE ml.family_id = $1`,
    [familyId],
  );
  if (!links.rows?.length) return { skipped: true, reason: "no_links" };

  const ids = links.rows.map((r) => Number(r.provider_market_id));
  const pmRes = await client.query(
    `SELECT pm.*, pr.code AS provider_code
     FROM pmci.provider_markets pm
     JOIN pmci.providers pr ON pr.id = pm.provider_id
     WHERE pm.id = ANY($1::bigint[])`,
    [ids],
  );
  const byId = new Map((pmRes.rows || []).map((r) => [Number(r.id), r]));
  const markets = ids.map((id) => byId.get(id)).filter(Boolean);
  if (markets.length < 2) return { skipped: true, reason: "missing_market_rows" };

  const cat =
    markets.map((m) => String(m.category || "").toLowerCase()).find((c) => c) || "unknown";
  const mfRes = await client.query(
    `SELECT id, label, notes, canonical_event_id, canonical_market_id FROM pmci.market_families WHERE id = $1`,
    [familyId],
  );
  const mf = mfRes.rows?.[0];
  if (!mf) return { skipped: true, reason: "no_family" };

  let canonicalEventId = mf.canonical_event_id;
  const titleBase = String(mf.label || markets.map((m) => m.title).join(" / ") || `family-${familyId}`).slice(0, 500);
  const slug = `phase7-family-${familyId}`;

  if (dryRun) {
    return { dryRun: true, familyId, canonicalEventId, markets: markets.length };
  }

  if (!canonicalEventId) {
    const insCe = await client.query(
      `INSERT INTO pmci.canonical_events (
         slug, title, category, metadata, source_annotation
       ) VALUES ($1, $2, $3, '{}'::jsonb, 'phase7_migration')
       ON CONFLICT (slug) DO UPDATE SET
         title = COALESCE(EXCLUDED.title, pmci.canonical_events.title),
         updated_at = now()
       RETURNING id`,
      [slug, titleBase, cat],
    );
    canonicalEventId = insCe.rows?.[0]?.id;
  } else {
    await client.query(
      `UPDATE pmci.canonical_events SET source_annotation = 'phase7_migration', updated_at = now()
       WHERE id = $1::uuid AND (source_annotation IS NULL OR source_annotation = 'unknown')`,
      [canonicalEventId],
    );
  }

  if (!canonicalEventId) return { error: "no_canonical_event" };

  await client.query(`UPDATE pmci.market_families SET canonical_event_id = $2::uuid WHERE id = $1`, [
    familyId,
    canonicalEventId,
  ]);

  const pemSql = `
    INSERT INTO pmci.provider_event_map (canonical_event_id, provider_id, provider_event_ref, confidence, match_method)
    VALUES ($1::uuid, $2::smallint, $3, 1.0, 'phase7_migration')
    ON CONFLICT (provider_id, provider_event_ref) DO UPDATE SET
      canonical_event_id = EXCLUDED.canonical_event_id,
      match_method = EXCLUDED.match_method
  `;

  let canonicalMarketIdForFamily = mf.canonical_market_id;

  for (const m of markets) {
    const code = String(m.provider_code || "").toLowerCase();
    let pref = "";
    if (code === "kalshi") {
      pref = kalshiProviderEventRefFromMarket(m);
    } else if (code === "polymarket") {
      pref = extractPolyEventSlug(m) || String(m.event_ref || "").trim();
    }
    if (!pref) pref = `unknown-${m.id}`;
    await client.query(pemSql, [canonicalEventId, m.provider_id, pref]);

    const { template, params } = classifyMarketTemplateForSlot({
      title: m.title,
      category: m.category,
      provider_market_ref: m.provider_market_ref,
      provider_id: m.provider_id,
    });
    const cmId = await findOrCreateCanonicalMarketSlot(client, canonicalEventId, m, template, params);
    await upsertProviderMarketMapRow(client, {
      canonicalMarketId: cmId,
      providerMarketId: Number(m.id),
      providerId: Number(m.provider_id),
      confidence: 1.0,
      matchMethod: "phase7_migration",
    });
    if (!canonicalMarketIdForFamily) canonicalMarketIdForFamily = cmId;
  }

  if (canonicalMarketIdForFamily) {
    await client.query(
      `UPDATE pmci.market_families SET canonical_market_id = $2::uuid WHERE id = $1 AND canonical_market_id IS NULL`,
      [familyId, canonicalMarketIdForFamily],
    );
  }

  return { ok: true, familyId, canonicalEventId, markets: markets.length };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  const dryRun = process.env.PHASE7_DRY_RUN === "1" || process.env.PHASE7_DRY_RUN === "true";
  const skipAutoLink =
    process.env.PHASE7_SKIP_AUTO_LINK !== "0" && process.env.PHASE7_SKIP_AUTO_LINK !== "false";
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  const report = {
    step: "phase_g_step7",
    dryRun,
    baseline_bilateral_families: 0,
    after_migration_bilateral_families: 0,
    families_processed: 0,
    migration_errors: [],
    attachment_snapshot: {},
    auto_link: null,
    link_rate_by_category: [],
    regression: { bilateral_families_unchanged: null, note: "" },
  };

  try {
    report.baseline_bilateral_families = await countBilateralFamilies(client);
    const familyIds = await loadFamilyIds(client);
    report.families_in_scope = familyIds.length;

    for (const fid of familyIds) {
      try {
        const res = await migrateOneFamily(client, fid, dryRun);
        if (res.ok || res.dryRun) report.families_processed += 1;
        if (res.error) report.migration_errors.push({ familyId: fid, ...res });
      } catch (e) {
        report.migration_errors.push({ familyId: fid, error: e?.message || String(e) });
      }
    }

    report.after_migration_bilateral_families = await countBilateralFamilies(client);
    report.regression.bilateral_families_unchanged =
      report.baseline_bilateral_families === report.after_migration_bilateral_families;
    report.regression.note = report.regression.bilateral_families_unchanged
      ? "OK: bilateral family count unchanged (market_links untouched)."
      : "CHECK: bilateral family count changed — investigate market_links / view.";

    report.attachment_snapshot = await attachmentStats(client);

    if (dryRun) {
      report.auto_link = { skipped: true, reason: "PHASE7_DRY_RUN" };
    } else if (skipAutoLink) {
      report.auto_link = {
        skipped: true,
        reason: "PHASE7_SKIP_AUTO_LINK (set PHASE7_SKIP_AUTO_LINK=0 to run auto-linker on unmapped markets)",
      };
    } else {
      const batch = Number(process.env.PMCI_AUTO_LINK_BATCH ?? "50000");
      report.auto_link = await runAutoLinkPass(client, { limit: batch });
    }

    const lr = await linkRateByCategory(client);
    report.link_rate_by_category = (lr.rows || []).map((r) => ({
      category: r.category,
      total_active: Number(r.total_active),
      linked_for_spread: Number(r.linked_spread),
      link_rate:
        Number(r.total_active) > 0
          ? Math.round((Number(r.linked_spread) / Number(r.total_active)) * 10000) / 100
          : 0,
    }));

    const totalActive = report.link_rate_by_category.reduce((a, r) => a + r.total_active, 0);
    const totalLinked = report.link_rate_by_category.reduce((a, r) => a + r.linked_for_spread, 0);
    report.overall = {
      total_active_markets: totalActive,
      total_with_spread_link: totalLinked,
      overall_link_rate_pct: totalActive > 0 ? Math.round((totalLinked / totalActive) * 10000) / 100 : 0,
    };
  } finally {
    await client.end();
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
