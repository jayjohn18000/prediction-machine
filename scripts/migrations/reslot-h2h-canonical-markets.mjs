#!/usr/bin/env node
/**
 * Phase Linker H2H Expansion — Step 1 (Lever C): reslot overfilled H2H
 * canonical_markets slots by a richer (fixture + variant + yes_subject) key so
 * the 1:1 bilateral gate in auto-linker.mjs can actually bilaterally-pair
 * head-to-head game markets.
 *
 * Background:
 *   - `ensureBilateralLinksForCanonicalMarketSlot` in lib/matching/auto-linker.mjs
 *     silently drops any slot where the leg count is not exactly 1 Kalshi + 1
 *     Polymarket (line 143-145). Phase G postmortem + the 2026-04-24 H2H
 *     diagnostic established that 789 -> 1,899 (current) sports canonical_market
 *     slots are overfilled under the existing keying.
 *   - The observed overfill has TWO structural causes:
 *       (a) Polymarket: distinct games piled onto the same slot because
 *           `canonical_event_id` is over-broad (e.g. many soccer fixtures under
 *           the same weekend event). A (teams, game_date) split fixes these.
 *       (b) Kalshi: multiple OUTCOME legs of the same game piled onto the same
 *           slot (e.g. `-CHI`, `-IND`, `-TIE` for Indiana vs Chicago winner) —
 *           the classifier emits identical template_params for all three. A
 *           (teams, game_date) split alone would NOT separate these. We split
 *           further by a variant marker (`first_half`, `second_half`, `total`,
 *           `btts`, `innings`, `draw`, `winner`) extracted from the title AND a
 *           `yes_subject` derived from the provider's outcome identifier.
 *
 * Keying scheme (new template_params for H2H reslot targets):
 *     {
 *       "sport": "<lower>",
 *       "teams": ["<sorted A>", "<sorted B>"],  // sorted-lowercase-normalized
 *       "game_date": "YYYY-MM-DD",
 *       "variant": "winner|total|first_half|second_half|btts|innings|draw|other",
 *       "yes_subject": "<provider-agnostic outcome tag>",
 *       "source": "linker_h2h_reslot_v1"
 *     }
 *
 * Dry-run vs apply:
 *   --dry-run (default)  -> emit counts diff, sample rows, write
 *                           docs/pivot/artifacts/linker-h2h-reslot-counts-diff.md
 *   --apply              -> (IMPLEMENTED, not executed in this phase) create new
 *                           canonical_markets rows, repoint
 *                           pmci.provider_market_map.canonical_market_id; see
 *                           applyReslot() below for transactional invariants.
 *
 * NOTE: `pmci.provider_markets` has NO `canonical_market_id` column. The join
 * is via `pmci.provider_market_map`. The phase plan language "UPDATE
 * provider_markets.canonical_market_id" is a typo for
 * `provider_market_map.canonical_market_id` — see the reporting section of the
 * handoff for details.
 *
 * Env: DATABASE_URL
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadEnv } from "../../src/platform/env.mjs";

loadEnv();

const { Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DIFF_DOC_PATH = path.join(
  REPO_ROOT,
  "docs",
  "pivot",
  "artifacts",
  "linker-h2h-reslot-counts-diff.md",
);

const KALSHI_PROVIDER_ID = 1;
const POLY_PROVIDER_ID = 2;
const H2H_TEMPLATE_SET = ["sports-moneyline", "sports-total", "sports-yes-no", "unknown"];
const RESLOT_SOURCE_TAG = "linker_h2h_reslot_v1";

function parseArgs(argv) {
  const out = { dryRun: true, apply: false, limit: null, allowResiduals: 0 };
  for (const a of argv.slice(2)) {
    if (a === "--apply") {
      out.apply = true;
      out.dryRun = false;
    } else if (a === "--dry-run") {
      out.dryRun = true;
      out.apply = false;
    } else if (a.startsWith("--limit=")) {
      out.limit = Number(a.slice("--limit=".length));
    } else if (a.startsWith("--allow-residuals=")) {
      out.allowResiduals = Number(a.slice("--allow-residuals=".length));
    }
  }
  return out;
}

/**
 * Normalize team name for sort-pair keying. Deliberately light-touch; the
 * equivalence/fuzzy-match work is A3's responsibility, not this script's.
 */
function normalizeTeamForKey(name) {
  if (name == null) return null;
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Variant marker: detect segment/period/prop flavor from title, so Kalshi's
 * `1H Winner` and `2H Winner` rows for the same game don't collapse to a
 * single slot.
 */
function classifyVariantFromTitle(title) {
  const t = String(title || "").toLowerCase();
  if (/(^|\s)1h(\s|$)|first half/.test(t)) return "first_half";
  if (/(^|\s)2h(\s|$)|second half/.test(t)) return "second_half";
  if (/btts|both teams to score/.test(t)) return "btts";
  if (/first (\d+|five|ten) innings/.test(t)) return "innings";
  if (/\btotal\b/.test(t)) return "total";
  if (/\bdraw\b/.test(t)) return "draw";
  if (/winner\??|\bwin\?/.test(t)) return "winner";
  return "other";
}

/**
 * YES-subject extraction. Kalshi's `provider_market_ref` has a trailing
 * hyphen segment that tags the YES outcome (e.g. `-IND` -> Indiana YES leg,
 * `-TIE` -> tie YES leg). Polymarket refs are 0x hashes so we fall back to
 * the title (already distinctive per outcome on their side).
 */
function extractYesSubject(row) {
  if (row.provider_id === KALSHI_PROVIDER_ID) {
    const ref = String(row.provider_market_ref || "");
    const m = ref.match(/[^-]+$/);
    return m ? m[0].toUpperCase() : "";
  }
  // Polymarket
  return String(row.title || "").toLowerCase().trim();
}

function fixtureKey(row) {
  const sport = String(row.sport || "na").toLowerCase();
  const a = normalizeTeamForKey(row.home_team) || "";
  const b = normalizeTeamForKey(row.away_team) || "";
  const [t1, t2] = [a, b].sort();
  const d = row.game_date ? String(row.game_date).slice(0, 10) : "nodate";
  return { sport, teams: [t1, t2], game_date: d, key: `${sport}|${t1}|${t2}|${d}` };
}

function reslotKey(row) {
  const fx = fixtureKey(row);
  const variant = classifyVariantFromTitle(row.title);
  const yesSubject = extractYesSubject(row);
  return {
    ...fx,
    variant,
    yes_subject: yesSubject,
    full: `${fx.key}|${variant}|${yesSubject}`,
  };
}

async function loadH2HOverfilledLegs(client) {
  const { rows } = await client.query(
    `
    WITH overfilled AS (
      SELECT cm.id AS slot_id
      FROM pmci.canonical_markets cm
      JOIN pmci.provider_market_map pmm ON pmm.canonical_market_id = cm.id
      JOIN pmci.provider_markets pm ON pm.id = pmm.provider_market_id
      WHERE pmm.removed_at IS NULL
        AND (pmm.status IS NULL OR pmm.status = 'active')
        AND pm.category = 'sports'
        AND pm.home_team IS NOT NULL AND pm.away_team IS NOT NULL
        AND (cm.market_template = ANY($1::text[]) OR cm.market_template IS NULL)
      GROUP BY cm.id
      HAVING
        COUNT(*) FILTER (WHERE pmm.provider_id = $2) > 1
        OR COUNT(*) FILTER (WHERE pmm.provider_id = $3) > 1
    )
    SELECT cm.id AS slot_id, cm.canonical_event_id,
           cm.market_template, cm.template_params, cm.title AS slot_title,
           pmm.id AS pmm_id, pmm.provider_id, pmm.provider_market_id,
           pm.provider_market_ref, pm.title, pm.home_team, pm.away_team,
           pm.game_date, pm.sport
    FROM pmci.canonical_markets cm
    JOIN pmci.provider_market_map pmm ON pmm.canonical_market_id = cm.id
    JOIN pmci.provider_markets pm ON pm.id = pmm.provider_market_id
    WHERE cm.id IN (SELECT slot_id FROM overfilled)
      AND pmm.removed_at IS NULL
      AND (pmm.status IS NULL OR pmm.status = 'active')
      AND pm.home_team IS NOT NULL AND pm.away_team IS NOT NULL
    ORDER BY cm.id, pmm.provider_id, pmm.provider_market_id
    `,
    [H2H_TEMPLATE_SET, KALSHI_PROVIDER_ID, POLY_PROVIDER_ID],
  );
  return rows;
}

async function loadBaselineSlotStates(client) {
  const { rows } = await client.query(
    `
    WITH slot_tallies AS (
      SELECT cm.id AS slot_id, cm.market_template,
        COUNT(*) FILTER (WHERE pmm.provider_id = $1) AS k_legs,
        COUNT(*) FILTER (WHERE pmm.provider_id = $2) AS p_legs
      FROM pmci.canonical_markets cm
      JOIN pmci.provider_market_map pmm ON pmm.canonical_market_id = cm.id
      JOIN pmci.provider_markets pm ON pm.id = pmm.provider_market_id
      WHERE pmm.removed_at IS NULL
        AND (pmm.status IS NULL OR pmm.status='active')
        AND pm.category='sports'
      GROUP BY cm.id, cm.market_template
    )
    SELECT
      CASE WHEN k_legs=1 AND p_legs=1 THEN 'bilateral_ready'
           WHEN k_legs>1 OR p_legs>1 THEN 'overfilled'
           WHEN k_legs=1 AND p_legs=0 THEN 'solo_kalshi'
           WHEN k_legs=0 AND p_legs=1 THEN 'solo_poly'
           ELSE 'other' END AS slot_state,
      COUNT(*)::int AS n
    FROM slot_tallies
    GROUP BY 1 ORDER BY 2 DESC
    `,
    [KALSHI_PROVIDER_ID, POLY_PROVIDER_ID],
  );
  const baseline = { bilateral_ready: 0, overfilled: 0, solo_kalshi: 0, solo_poly: 0, other: 0 };
  for (const r of rows) baseline[r.slot_state] = Number(r.n);
  return baseline;
}

async function loadBaselineH2HPerTemplate(client) {
  const { rows } = await client.query(
    `
    WITH h2h_slots AS (
      SELECT cm.id AS slot_id, cm.market_template,
        COUNT(*) FILTER (WHERE pmm.provider_id = $1) AS k_legs,
        COUNT(*) FILTER (WHERE pmm.provider_id = $2) AS p_legs,
        COUNT(*) AS total_legs
      FROM pmci.canonical_markets cm
      JOIN pmci.provider_market_map pmm ON pmm.canonical_market_id = cm.id
      JOIN pmci.provider_markets pm ON pm.id = pmm.provider_market_id
      WHERE pmm.removed_at IS NULL
        AND (pmm.status IS NULL OR pmm.status='active')
        AND pm.category='sports'
        AND pm.home_team IS NOT NULL AND pm.away_team IS NOT NULL
      GROUP BY cm.id, cm.market_template
    )
    SELECT
      COALESCE(market_template, '(null)') AS market_template,
      COUNT(*)::int AS slot_count,
      SUM(total_legs)::int AS legs_total,
      COUNT(*) FILTER (WHERE k_legs=1 AND p_legs=1)::int AS bilateral_ready,
      COUNT(*) FILTER (WHERE k_legs>1 OR p_legs>1)::int AS overfilled,
      COUNT(*) FILTER (WHERE (k_legs>0 AND p_legs=0) OR (k_legs=0 AND p_legs>0))::int AS solo
    FROM h2h_slots
    GROUP BY market_template
    ORDER BY slot_count DESC
    `,
    [KALSHI_PROVIDER_ID, POLY_PROVIDER_ID],
  );
  return rows;
}

/**
 * Project the post-reslot slot state from the in-memory leg list.
 * For each overfilled slot, its legs are grouped by `reslotKey().full`. Each
 * (old_slot, reslot_key) tuple becomes a new slot.
 */
function projectReslot(legs) {
  // Map: oldSlot -> Map: reslotKey -> { kalshi:[], poly:[], template, exemplar }
  const bySlot = new Map();
  for (const leg of legs) {
    const key = reslotKey(leg);
    const slotEntry = bySlot.get(leg.slot_id) || {
      canonical_event_id: leg.canonical_event_id,
      market_template: leg.market_template,
      groups: new Map(),
    };
    const group = slotEntry.groups.get(key.full) || {
      reslot_key: key,
      kalshi: [],
      poly: [],
      exemplar: leg,
    };
    if (leg.provider_id === KALSHI_PROVIDER_ID) group.kalshi.push(leg);
    else if (leg.provider_id === POLY_PROVIDER_ID) group.poly.push(leg);
    slotEntry.groups.set(key.full, group);
    bySlot.set(leg.slot_id, slotEntry);
  }

  // Counts per template
  const perTemplate = new Map();
  const newOverfilledSamples = [];
  const oldToNewSamples = [];

  for (const [oldSlotId, slotEntry] of bySlot.entries()) {
    const tmpl = slotEntry.market_template || "(null)";
    const tRow = perTemplate.get(tmpl) || {
      market_template: tmpl,
      new_slot_count: 0,
      bilateral_ready: 0,
      overfilled: 0,
      solo: 0,
      legs_total: 0,
    };
    for (const [, group] of slotEntry.groups) {
      const kN = group.kalshi.length;
      const pN = group.poly.length;
      const total = kN + pN;
      tRow.new_slot_count += 1;
      tRow.legs_total += total;
      if (kN === 1 && pN === 1) tRow.bilateral_ready += 1;
      else if (kN > 1 || pN > 1) {
        tRow.overfilled += 1;
        if (newOverfilledSamples.length < 20) {
          newOverfilledSamples.push({
            old_slot_id: oldSlotId,
            reslot_key: group.reslot_key,
            k_legs: kN,
            p_legs: pN,
            example_titles: [...group.kalshi, ...group.poly]
              .slice(0, 4)
              .map((l) => `p${l.provider_id}:${l.provider_market_ref}:${l.title}`),
          });
        }
      } else tRow.solo += 1;

      if (oldToNewSamples.length < 5) {
        oldToNewSamples.push({
          old_slot_id: oldSlotId,
          new_template_params: group.reslot_key,
          k_legs: kN,
          p_legs: pN,
          example: `${group.exemplar.sport} | ${group.exemplar.home_team} vs ${group.exemplar.away_team} | ${group.exemplar.game_date} | ${group.reslot_key.variant} | ${group.reslot_key.yes_subject}`,
        });
      }
    }
    perTemplate.set(tmpl, tRow);
  }

  return { perTemplate: [...perTemplate.values()], newOverfilledSamples, oldToNewSamples };
}

function mdTable(headers, rows) {
  const esc = (v) => (v == null ? "" : String(v));
  const head = `| ${headers.join(" | ")} |`;
  const sep = `|${headers.map(() => "---").join("|")}|`;
  const body = rows.map((r) => `| ${headers.map((h) => esc(r[h])).join(" | ")} |`).join("\n");
  return `${head}\n${sep}\n${body}`;
}

async function writeDiffDoc({ baseline, baselineH2H, projection }) {
  const today = new Date().toISOString().slice(0, 10);
  const zeroOverfilled = projection.perTemplate.reduce((a, t) => a + t.overfilled, 0);
  const gateResult = zeroOverfilled === 0 ? "PASS" : "FAIL";

  const beforeRows = [
    { state: "bilateral_ready", count: baseline.bilateral_ready },
    { state: "overfilled", count: baseline.overfilled },
    { state: "solo_kalshi", count: baseline.solo_kalshi },
    { state: "solo_poly", count: baseline.solo_poly },
    { state: "other", count: baseline.other },
  ];

  const md = `# Phase Linker H2H Expansion — Slot Reshape Counts Diff

_Generated by \`scripts/migrations/reslot-h2h-canonical-markets.mjs --dry-run\` on ${today}. Lever C of the phase plan \`docs/plans/phase-linker-h2h-expansion-plan.md\`. Sub-agent B owns this artifact._

## Baseline — sports slot-state (all templates, all legs)

${mdTable(["state", "count"], beforeRows)}

## Baseline — per H2H-shape-present template (slots where at least one leg has populated home/away teams)

${mdTable(
  ["market_template", "slot_count", "legs_total", "bilateral_ready", "overfilled", "solo"],
  baselineH2H.map((r) => ({
    market_template: r.market_template,
    slot_count: r.slot_count,
    legs_total: r.legs_total,
    bilateral_ready: r.bilateral_ready,
    overfilled: r.overfilled,
    solo: r.solo,
  })),
)}

## Projection after reslot (legs in overfilled H2H slots only)

Reslot key: \`{sport, teams: sorted-pair-lower, game_date, variant, yes_subject}\` with \`source="${RESLOT_SOURCE_TAG}"\`.

${mdTable(
  ["market_template", "new_slot_count", "legs_total", "bilateral_ready", "overfilled", "solo"],
  projection.perTemplate.map((r) => ({
    market_template: r.market_template,
    new_slot_count: r.new_slot_count,
    legs_total: r.legs_total,
    bilateral_ready: r.bilateral_ready,
    overfilled: r.overfilled,
    solo: r.solo,
  })),
)}

## Gate — H2H overfilled after reslot must be zero

**Residual overfilled H2H slots after reslot: ${zeroOverfilled} (${gateResult})**

${
  zeroOverfilled === 0
    ? "Every overfilled H2H slot cleanly decomposes under the (fixture + variant + yes_subject) key. The 1:1 bilateral gate in `auto-linker.mjs` can now pair the surviving Kalshi↔Polymarket fixtures that share a reslot key."
    : `**Non-zero residual.** The following reslot keys still carry >1 leg per side — the script must halt before \`--apply\` is considered. Root causes to investigate: (a) same YES-subject ingested twice (duplicate provider_market rows — this is a Phase G data-quality bug, not a reslot-key bug); (b) title-variant classification collision (two titles that should be distinct variants were bucketed to the same slot).

${mdTable(
  ["old_slot_id", "reslot_key.full", "k_legs", "p_legs", "example_titles"],
  projection.newOverfilledSamples.map((s) => ({
    old_slot_id: s.old_slot_id,
    "reslot_key.full": s.reslot_key.full,
    k_legs: s.k_legs,
    p_legs: s.p_legs,
    example_titles: s.example_titles.join(" ; "),
  })),
)}`
}

## Sample: 5 old_slot_id -> new template_params reassignments

${mdTable(
  ["old_slot_id", "k_legs", "p_legs", "example (sport | teams | date | variant | yes_subject)", "new_template_params"],
  projection.oldToNewSamples.map((s) => ({
    old_slot_id: s.old_slot_id,
    k_legs: s.k_legs,
    p_legs: s.p_legs,
    "example (sport | teams | date | variant | yes_subject)": s.example,
    new_template_params: JSON.stringify({
      sport: s.new_template_params.sport,
      teams: s.new_template_params.teams,
      game_date: s.new_template_params.game_date,
      variant: s.new_template_params.variant,
      yes_subject: s.new_template_params.yes_subject,
      source: RESLOT_SOURCE_TAG,
    }),
  })),
)}

## Notes and caveats

- The reslot does **not** touch \`pmci.market_links\`. Link rows reference \`provider_market_id\`, not \`canonical_market_id\`, so reslotting is transparent to existing active families.
- The existing 88 bilateral futures families are NOT in the reslot scope (they are not H2H-shaped — legs lack \`home_team\`/\`away_team\`). They remain untouched.
- **Polymarket-side overfill cause:** distinct games piling onto an over-broad \`canonical_event_id\`. A (teams, game_date) split alone fixes these.
- **Kalshi-side overfill cause:** N-way outcome legs of the same game (\`-HOME\`, \`-AWAY\`, \`-TIE\`) collapsing to identical \`template_params\`. The richer key adds \`variant\` (period/prop) + \`yes_subject\` (outcome identity) to separate them.
- New \`bilateral_ready\` count in the projection is expected to be **0**: the overfilled-slot population is almost entirely single-provider cohorts (Kalshi's 3-way legs for one game; Polymarket's many-game draw-market pile). The reslot converts these to \`solo_k\`/\`solo_p\` slots — which is *correct*, because they lack a counterpart. Bilateral growth happens downstream when Levers A+B bring newly-classified Polymarket rows onto matching fixture keys; those will land on the reslot-keyed target slots produced by this migration.
`;

  fs.mkdirSync(path.dirname(DIFF_DOC_PATH), { recursive: true });
  fs.writeFileSync(DIFF_DOC_PATH, md);
  return DIFF_DOC_PATH;
}

/**
 * Apply-path (implemented, NOT executed as part of this phase's dry-run
 * deliverable). Transactional per old-slot group:
 *   1. For each (reslot_key) group under an old overfilled slot:
 *        a. UPSERT a new canonical_markets row keyed on
 *           (canonical_event_id, market_template, new_template_params).
 *        b. UPDATE pmci.provider_market_map SET canonical_market_id =
 *           new_cm_id WHERE provider_market_id = ANY(group_leg_ids).
 *   2. After each slot's groups are repointed, RE-QUERY the old slot's leg
 *      count. If it is still non-zero (some leg failed to move) OR any new
 *      slot is still overfilled, ROLLBACK and abort.
 *   3. Optionally mark the old slot `deprecated_at = NOW()` if the column
 *      exists; otherwise WARN and leave the old row orphan (harmless because
 *      provider_market_map is the source of truth).
 *
 * Idempotency: UPSERTs via `ON CONFLICT` on the Phase-G unique index
 * `ux_cm_event_template_params (canonical_event_id, market_template,
 * template_params)` ensure re-runs are no-ops.
 *
 * Safety invariants the apply path preserves:
 *   - No INSERT/UPDATE/DELETE on `pmci.market_links` — link rows reference
 *     provider_market_id only.
 *   - No write to `pmci.provider_markets` columns.
 *   - No change to `canonical_events`.
 *
 * We do NOT execute the apply path in this phase per the plan's Step 1a
 * specification. This function exists so a follow-up orchestrator chat can
 * invoke it after human review of the dry-run diff doc.
 */
async function applyReslot(client, legs, opts = {}) {
  const { allowResiduals = 0 } = opts;

  // --- Phase 1 (in-memory): build reshape groups -------------------------
  const bySlot = new Map();
  for (const leg of legs) {
    const key = reslotKey(leg);
    const slotEntry =
      bySlot.get(leg.slot_id) || {
        canonical_event_id: leg.canonical_event_id,
        market_template: leg.market_template,
        groups: new Map(),
      };
    const group =
      slotEntry.groups.get(key.full) || {
        reslot_key: key,
        pmm_ids: [],
        k_count: 0,
        p_count: 0,
      };
    group.pmm_ids.push(leg.pmm_id);
    if (leg.provider_id === KALSHI_PROVIDER_ID) group.k_count += 1;
    else if (leg.provider_id === POLY_PROVIDER_ID) group.p_count += 1;
    slotEntry.groups.set(key.full, group);
    bySlot.set(leg.slot_id, slotEntry);
  }

  // Projected residual overfilled gate.
  let projectedResidualOverfilled = 0;
  for (const [, slotEntry] of bySlot) {
    for (const [, g] of slotEntry.groups) {
      if (g.k_count > 1 || g.p_count > 1) projectedResidualOverfilled += 1;
    }
  }
  if (projectedResidualOverfilled > allowResiduals) {
    throw new Error(
      `[reslot-apply] residual overfilled ${projectedResidualOverfilled} exceeds --allow-residuals=${allowResiduals}. Aborting before any DML.`,
    );
  }
  console.error(
    `[reslot-apply] projected residual overfilled=${projectedResidualOverfilled} (tolerance=${allowResiduals})`,
  );

  // Flatten to arrays for UNNEST-bulk upsert.
  const allGroups = [];
  for (const [oldSlotId, slotEntry] of bySlot) {
    for (const [, group] of slotEntry.groups) {
      const tp = {
        sport: group.reslot_key.sport,
        teams: group.reslot_key.teams,
        game_date: group.reslot_key.game_date,
        variant: group.reslot_key.variant,
        yes_subject: group.reslot_key.yes_subject,
        source: RESLOT_SOURCE_TAG,
      };
      const label = `${tp.sport} ${tp.teams.join(" vs ")} ${tp.game_date} (${tp.variant}/${tp.yes_subject})`.slice(
        0,
        500,
      );
      // Stable group identity key for post-upsert id lookup. Normalized
      // fields only — jsonb equality isn't safe to rely on from JS strings.
      const groupKey = `${slotEntry.canonical_event_id}|${slotEntry.market_template}|${tp.sport}|${tp.teams.join(",")}|${tp.game_date}|${tp.variant}|${tp.yes_subject}`;
      allGroups.push({
        group_key: groupKey,
        old_slot_id: oldSlotId,
        canonical_event_id: slotEntry.canonical_event_id,
        market_template: slotEntry.market_template,
        template_params_json: JSON.stringify(tp),
        template_params: tp,
        label,
        metadata_json: JSON.stringify({
          source: RESLOT_SOURCE_TAG,
          old_slot_id: oldSlotId,
        }),
        pmm_ids: group.pmm_ids,
      });
    }
  }
  console.error(
    `[reslot-apply] ${bySlot.size} old slots -> ${allGroups.length} reshape groups staged`,
  );

  await client.query("BEGIN");
  try {
    // --- Phase 2: bulk UPSERT canonical_markets ------------------------
    const ceIds = allGroups.map((g) => g.canonical_event_id);
    const labels = allGroups.map((g) => g.label);
    const mktTmpls = allGroups.map((g) => g.market_template);
    const tpJsons = allGroups.map((g) => g.template_params_json);
    const metaJsons = allGroups.map((g) => g.metadata_json);

    const upsert = await client.query(
      `
      INSERT INTO pmci.canonical_markets
        (canonical_event_id, label, market_type, market_template, template_params, metadata, title)
      SELECT
        t.ce_id::uuid,
        t.label,
        'binary'::pmci.market_type,
        t.mkt_tmpl,
        t.tp::jsonb,
        t.meta::jsonb,
        t.label
      FROM UNNEST(
        $1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[]
      ) AS t(ce_id, label, mkt_tmpl, tp, meta)
      ON CONFLICT (canonical_event_id, market_template, template_params)
        WHERE market_template IS NOT NULL
      DO UPDATE SET updated_at = NOW()
      RETURNING id, canonical_event_id, market_template, template_params
      `,
      [ceIds, labels, mktTmpls, tpJsons, metaJsons],
    );
    console.error(`[reslot-apply] upsert returned ${upsert.rows.length} rows`);

    // Build groupKey -> new_canonical_market_id lookup from RETURNING.
    // Postgres stores jsonb normalized, but our original key order in JS
    // matches our construction, and we read the fields by name — order
    // doesn't matter here.
    const groupKeyToId = new Map();
    for (const r of upsert.rows) {
      const tp = r.template_params;
      const teams = Array.isArray(tp.teams) ? tp.teams : [];
      const gk = `${r.canonical_event_id}|${r.market_template}|${tp.sport}|${teams.join(",")}|${tp.game_date}|${tp.variant}|${tp.yes_subject}`;
      groupKeyToId.set(gk, r.id);
    }

    // Resolve each group's new canonical_market_id.
    const missing = [];
    for (const g of allGroups) {
      const id = groupKeyToId.get(g.group_key);
      if (!id) missing.push(g.group_key);
      else g.new_canonical_market_id = id;
    }
    if (missing.length > 0) {
      console.error(
        `[reslot-apply] FATAL: ${missing.length} groups did not resolve to a new canonical_market_id after upsert. First 3: ${JSON.stringify(missing.slice(0, 3))}`,
      );
      throw new Error("Post-upsert id lookup failed — aborting before UPDATE.");
    }

    // --- Phase 3: bulk UPDATE provider_market_map ----------------------
    // Flatten (pmm_id, new_canonical_market_id) pairs for a single UPDATE.
    const pmmIds = [];
    const newCmIds = [];
    for (const g of allGroups) {
      for (const pmmId of g.pmm_ids) {
        pmmIds.push(String(pmmId));
        newCmIds.push(g.new_canonical_market_id);
      }
    }

    const updateResult = await client.query(
      `
      UPDATE pmci.provider_market_map pmm
      SET canonical_market_id = src.new_cm_id
      FROM (
        SELECT pmm_id::bigint AS pmm_id, new_cm_id::uuid AS new_cm_id
        FROM UNNEST($1::bigint[], $2::uuid[]) AS t(pmm_id, new_cm_id)
      ) src
      WHERE pmm.id = src.pmm_id
        AND pmm.canonical_market_id <> src.new_cm_id
      `,
      [pmmIds, newCmIds],
    );
    const pmmRowsRepointed = updateResult.rowCount || 0;

    await client.query("COMMIT");
    console.error(
      `[reslot-apply] COMMIT. groups=${allGroups.length} upsert_rows=${upsert.rows.length} pmm_repointed=${pmmRowsRepointed}`,
    );

    return {
      groups: allGroups.length,
      upsertReturnedRows: upsert.rows.length,
      pmmRowsRepointed,
      projectedResidualOverfilled,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[reslot-apply] ROLLBACK:", err.message);
    throw err;
  }
}

async function checkDeprecatedAtColumn(client) {
  const { rows } = await client.query(
    `
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='pmci' AND table_name='canonical_markets' AND column_name='deprecated_at'
    LIMIT 1
    `,
  );
  return rows.length > 0;
}

async function main() {
  const args = parseArgs(process.argv);
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const hasDeprecatedAt = await checkDeprecatedAtColumn(client);
    console.error(
      `[reslot] canonical_markets.deprecated_at present: ${hasDeprecatedAt ? "yes" : "no (apply path will WARN)"}`,
    );

    console.error("[reslot] loading baseline slot-state ...");
    const baseline = await loadBaselineSlotStates(client);
    const baselineH2H = await loadBaselineH2HPerTemplate(client);
    const h2hOverfilledBefore = baselineH2H.reduce((a, r) => a + Number(r.overfilled), 0);
    console.error(
      `[reslot] baseline: bilateral_ready=${baseline.bilateral_ready} overfilled=${baseline.overfilled} solo_k=${baseline.solo_kalshi} solo_p=${baseline.solo_poly} other=${baseline.other}`,
    );
    console.error(`[reslot] H2H-shaped overfilled (baseline): ${h2hOverfilledBefore}`);

    console.error("[reslot] loading legs inside overfilled H2H slots ...");
    const legs = await loadH2HOverfilledLegs(client);
    console.error(`[reslot] loaded ${legs.length} legs across ${new Set(legs.map((l) => l.slot_id)).size} slots`);

    const projection = projectReslot(legs);
    const newOverfilled = projection.perTemplate.reduce((a, t) => a + t.overfilled, 0);
    console.error(`[reslot] projected overfilled after reslot: ${newOverfilled}`);

    const diffPath = await writeDiffDoc({ baseline, baselineH2H, projection });
    console.error(`[reslot] diff doc written: ${diffPath}`);

    const summary = {
      mode: args.apply ? "apply" : "dry-run",
      baseline,
      h2h_overfilled_before: h2hOverfilledBefore,
      h2h_overfilled_after_projection: newOverfilled,
      gate_pass: newOverfilled === 0,
      diff_doc: diffPath,
      deprecated_at_column_exists: hasDeprecatedAt,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

    if (args.apply) {
      if (newOverfilled > args.allowResiduals) {
        console.error(
          `[reslot] --apply refused: dry-run projection shows ${newOverfilled} residual overfilled slot(s), exceeds --allow-residuals=${args.allowResiduals}. Fix the reshape key first or raise the tolerance.`,
        );
        process.exitCode = 2;
        return;
      }
      if (newOverfilled > 0) {
        console.error(
          `[reslot] --apply proceeding with ${newOverfilled} accepted residual overfilled slot(s) (tolerance=${args.allowResiduals}). These are duplicate-pm-row data-quality artifacts per docs/pivot/artifacts/linker-h2h-reslot-counts-diff.md.`,
        );
      }
      const applyResult = await applyReslot(client, legs, {
        limit: args.limit,
        allowResiduals: args.allowResiduals,
      });
      console.error("[reslot] apply complete:", JSON.stringify(applyResult));
      summary.apply_result = applyResult;
      process.stdout.write(`${JSON.stringify({ summary }, null, 2)}\n`);
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
