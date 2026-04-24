import fs from "node:fs";
import path from "node:path";

/**
 * RFC-style CSV (quoted fields, newlines inside quotes) — A3 rules columns use multiline strings.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsvWithNewlinesInQuotes(text) {
  const rows = [];
  const row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        field += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (c === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }
    if ((c === "\n" || c === "\r") && !inQuotes) {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      if (row.some((x) => x !== "")) rows.push([...row]);
      row.length = 0;
      field = "";
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

/**
 * Parse A3 resolution-equivalence CSV. Returns map family_id (string) -> row.
 * @param {string} csvPath
 * @param {{ allowAmbiguous: boolean, excludeFamilyIds: Set<string> }} opts
 * @returns {{ byFamily: Map<string, { classification: string, family_id: string }>, warnings: string[] }}
 */
export function loadEquivalenceCsv(csvPath, opts = {}) {
  const { allowAmbiguous = false, excludeFamilyIds = new Set() } = opts;
  const warnings = [];
  const raw = fs.readFileSync(csvPath, "utf8");
  const table = parseCsvWithNewlinesInQuotes(raw);
  if (table.length < 2) {
    return { byFamily: new Map(), warnings: ["A3 CSV has no data rows."] };
  }
  const header = table[0].map((h) => String(h).trim());
  const classIdx = header.indexOf("classification");
  const famIdx = header.indexOf("family_id");
  if (classIdx < 0 || famIdx < 0) {
    throw new Error(
      `A3 CSV missing required columns (need classification, family_id). Got: ${header.join(",")}`,
    );
  }
  const byFamily = new Map();
  for (let r = 1; r < table.length; r += 1) {
    const parts = table[r];
    if (parts.length < header.length) continue;
    const familyId = String(parts[famIdx] ?? "").trim();
    if (!familyId) continue;
    if (excludeFamilyIds.has(familyId)) continue;
    const classification = String(parts[classIdx] ?? "").trim().toLowerCase();
    byFamily.set(familyId, { classification, family_id: familyId });
  }
  for (const [fid, { classification: c }] of [...byFamily.entries()]) {
    if (c === "non_equivalent" || c === "non-equivalent") {
      byFamily.delete(fid);
    } else if (c === "ambiguous" && !allowAmbiguous) {
      byFamily.delete(fid);
    } else if (c !== "equivalent" && c !== "ambiguous") {
      byFamily.delete(fid);
    }
  }
  if (byFamily.size === 0) {
    warnings.push(
      "No families remain after A3 filter (only classification='equivalent' counts; use --include-ambiguous for dev scaffold).",
    );
  }
  return { byFamily, warnings };
}

export function defaultA3Path(repoRoot) {
  return path.join(repoRoot, "docs/pivot/artifacts/a3-resolution-equivalence-audit.csv");
}
