import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Handlebars from "handlebars";

import { resolveWritePath } from "./report-paths.mjs";
import {
  loadCapitalSummary,
  loadCrossDayPatterns,
  loadDecayState,
  loadHypothesesSummary,
  loadUnifiedSignals,
} from "./scanner-queries.mjs";
import { uploadReportIfConfigured } from "./s3-upload-report.mjs";

/** @typedef {import('pg').Client | import('pg').PoolClient} PgConn */

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, "..", "..");

/**
 * @param {PgConn} client
 * @returns {Promise<string>}
 */
export async function loadIsoWeekStampFromDb(client, ref = new Date()) {
  try {
    const { rows } = await client.query(
      `SELECT to_char(($1::timestamptz AT TIME ZONE 'UTC')::date, 'IYYY') || '-W' ||
             lpad(to_char(($1::timestamptz AT TIME ZONE 'UTC')::date, 'IW'), 2, '0') AS stamp`,
      [ref],
    );
    return rows[0]?.stamp ?? new Date().toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Retire hypotheses where decay marks triggers_retire and status is active.
 * @param {PgConn} client
 * @returns {Promise<{ retired: string[], errors: string[] }>}
 */
export async function runAutoRetire(client) {
  const retired = [];
  const errors = [];
  let candidates = [];
  try {
    const r = await client.query(
      `SELECT d.hypothesis_id::text AS hypothesis_id
       FROM pmci.hypothesis_decay_state d
       JOIN pmci.hypotheses h ON h.id::text = d.hypothesis_id::text
       WHERE d.triggers_retire IS TRUE
         AND h.status::text IN ('live', 'testing')`,
    );
    candidates = r.rows ?? [];
  } catch (e) {
    errors.push(/** @type {Error} */ (e).message);
    return { retired, errors };
  }

  for (const row of candidates) {
    const hid = row.hypothesis_id;
    try {
      await client.query("BEGIN");
      const before = await client.query(
        `SELECT status::text AS status FROM pmci.hypotheses WHERE id::text = $1 FOR UPDATE`,
        [hid],
      );
      const fromStatus = before.rows[0]?.status ?? "unknown";
      await client.query(
        `UPDATE pmci.hypotheses
         SET status = 'retired',
             retired_at = COALESCE(retired_at, now()),
             retired_reason = COALESCE(retired_reason, 'decay_or_kswin')
         WHERE id::text = $1
           AND status::text IN ('live', 'testing')`,
        [hid],
      );
      await client.query(
        `INSERT INTO pmci.hypothesis_state_log
           (hypothesis_id, from_status, to_status, reason, actor)
         VALUES ($1, $2, 'retired', 'hypothesis_decay_state.triggers_retire', 'system')`,
        [hid, fromStatus],
      );
      await client.query("COMMIT");
      retired.push(hid);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      errors.push(`${hid}: ${/** @type {Error} */ (e).message}`);
    }
  }
  return { retired, errors };
}

/**
 * @param {{ client: PgConn, weekStamp?: string, now?: Date }} opts
 */
export async function renderWeeklyDigestHtml(opts) {
  const { client } = opts;
  const now = opts.now ?? new Date();
  const weekStamp = opts.weekStamp ?? (await loadIsoWeekStampFromDb(client, now));

  const [signals, hypotheses, decay, capital, patterns] = await Promise.all([
    loadUnifiedSignals(client),
    loadHypothesesSummary(client),
    loadDecayState(client),
    loadCapitalSummary(client),
    loadCrossDayPatterns(client),
  ]);

  const retirementList = decay.filter((d) => d.triggers_retire);
  const promotionCandidates = hypotheses.filter((h) =>
    ["scanning", "proposed", "testing"].includes(String(h.status)),
  );

  const tmplPath = path.join(ROOT, "templates", "weekly-digest.html.hbs");
  const templateSource = await fs.readFile(tmplPath, "utf8");
  Handlebars.registerHelper("jsonify", (val) => {
    try {
      return JSON.stringify(val, null, 2);
    } catch {
      return String(val);
    }
  });
  const template = Handlebars.compile(templateSource);

  return template({
    weekStamp,
    generatedAt: now.toISOString(),
    signalCount: signals.length,
    signalsSample: signals.slice(0, 60),
    decay,
    capital,
    crossDayPatterns: patterns,
    promotionCandidates: promotionCandidates.slice(0, 40),
    retirementList,
    hypotheses: hypotheses.slice(0, 80),
  });
}

/**
 * @param {{ client: PgConn, weekStamp?: string, now?: Date, skipAutoRetire?: boolean }} opts
 */
export async function writeWeeklyDigest(opts = {}) {
  const { client, skipAutoRetire } = opts;
  const now = opts.now ?? new Date();
  let retireSummary = null;
  if (!skipAutoRetire) retireSummary = await runAutoRetire(client);

  const weekStamp =
    opts.weekStamp ?? (await loadIsoWeekStampFromDb(client, now));
  const html = await renderWeeklyDigestHtml({ client, weekStamp, now });

  const htmlPath = await resolveWritePath("weekly", weekStamp);
  await fs.writeFile(htmlPath, html, "utf8");
  const s3 = await uploadReportIfConfigured({
    localPath: htmlPath,
    s3Key: `weekly/${weekStamp}.html`,
  });

  return { htmlPath, s3, autoRetire: retireSummary ?? { skipped: true } };
}
