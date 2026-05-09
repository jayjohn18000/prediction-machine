import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Handlebars from "handlebars";

import { resolveWritePath } from "./report-paths.mjs";
import {
  loadCrossDayPatterns,
  loadDecayState,
  loadHypothesisHitRates,
  loadHypothesesSummary,
  loadUnifiedSignals,
} from "./scanner-queries.mjs";
import { uploadReportIfConfigured } from "./s3-upload-report.mjs";
import { intervalStraddlesHalf, wilsonInterval } from "./stats-ci.mjs";

/** @typedef {import('pg').Client | import('pg').PoolClient} PgConn */

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, "..", "..");

/**
 * @param {{ client: PgConn, dateStamp: string, now?: Date }} opts dateStamp YYYY-MM-DD UTC
 */
export async function renderDailyReportHtml(opts) {
  const { client, dateStamp } = opts;
  const now = opts.now ?? new Date();

  const [signals, rankedRaw, hypotheses, decay] = await Promise.all([
    loadUnifiedSignals(client),
    loadHypothesisHitRates(client),
    loadHypothesesSummary(client),
    loadDecayState(client),
  ]);

  const patterns = (await loadCrossDayPatterns(client)).slice(0, 14);

  const ranked = rankedRaw.map((row) => {
    const hits = Number(row.hits ?? 0);
    const n = Number(row.n_labeled ?? 0);
    const ci = wilsonInterval(hits, n);
    return {
      hypothesis_id: row.hypothesis_id,
      hits,
      n,
      hit_rate: n ? hits / n : null,
      ci_low: ci.low,
      ci_high: ci.high,
      ambiguous_star: intervalStraddlesHalf(ci),
    };
  });

  const tmplPath = path.join(ROOT, "templates", "daily-report.html.hbs");
  const templateSource = await fs.readFile(tmplPath, "utf8");
  const template = Handlebars.compile(templateSource);

  const html = template({
    dateStamp,
    generatedAt: now.toISOString(),
    signalCount: signals.length,
    signals: signals.slice(0, 80),
    ranked,
    hypotheses: hypotheses.slice(0, 80),
    decay: decay.slice(0, 80),
    crossDayPatterns: patterns,
    promotionCandidates: hypotheses.filter((h) =>
      ["scanning", "proposed", "testing"].includes(String(h.status)),
    ),
  });

  return html;
}

/**
 * @param {{ client: PgConn, dateStamp?: string, now?: Date }} [opts]
 * @returns {Promise<{ htmlPath: string, s3?: object }>}
 */
export async function writeDailyReport(opts = {}) {
  const { client } = opts;
  const dateStamp =
    opts.dateStamp ??
    new Date().toISOString().slice(0, 10);
  const now = opts.now ?? new Date();

  const html = await renderDailyReportHtml({ client, dateStamp, now });
  const htmlPath = await resolveWritePath("daily", dateStamp);
  await fs.writeFile(htmlPath, html, "utf8");

  const s3 = await uploadReportIfConfigured({
    localPath: htmlPath,
    s3Key: `daily/${dateStamp}.html`,
  });

  return { htmlPath, s3 };
}
