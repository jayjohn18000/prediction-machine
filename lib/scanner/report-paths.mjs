import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, "..", "..");

/** @returns {string} Writable reports root under repo (or PMCI_REPORTS_LOCAL_DIR override). */
export function getReportsRoot() {
  return process.env.PMCI_REPORTS_LOCAL_DIR?.trim() || path.join(ROOT, "reports");
}

/** @returns {Promise<void>} */
export async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

/**
 * @param {"daily"|"weekly"} kind
 * @param {string} stamp YYYY-MM-DD or YYYY-Www
 */
export function reportFilename(kind, stamp) {
  return kind === "daily" ? `daily-report-${stamp}.html` : `weekly-digest-${stamp}.html`;
}

/** @returns {Promise<string>} Absolute file path written. */
export async function resolveWritePath(kind, stamp) {
  const sub = kind === "daily" ? "daily" : "weekly";
  const dir = path.join(getReportsRoot(), sub);
  await ensureDir(dir);
  return path.join(dir, reportFilename(kind, stamp));
}
