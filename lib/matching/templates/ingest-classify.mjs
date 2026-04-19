/**
 * After upsert: apply rule-based template classification (no LLM — backfill handles LLM).
 */
import { classifyTemplate } from "./index.mjs";
import { classifyPhaseGSportsMarketType } from "../../normalization/market-type-classifier.mjs";

const SQL = `
  UPDATE pmci.provider_markets
  SET market_template = $2,
      template_params = $3::jsonb
  WHERE id = $1
`;

function classifyOnIngestEnabled() {
  const v = process.env.PMCI_CLASSIFY_ON_INGEST;
  if (v === "0" || v === "false") return false;
  return true;
}

/**
 * @param {import('pg').Client} client
 * @param {{ id: number, title?: string, provider_market_ref?: string, provider_id?: number, category?: string }} row
 */
export async function maybeApplyTemplateAfterIngest(client, row) {
  if (!client || !row?.id || !classifyOnIngestEnabled()) return false;
  const cat = String(row?.category || "").toLowerCase();
  let hit = null;
  if (cat === "sports") {
    hit = classifyPhaseGSportsMarketType(row);
  }
  if (!hit) {
    hit = classifyTemplate({
      title: row.title,
      provider_market_ref: row.provider_market_ref,
      provider_id: row.provider_id,
      category: row.category,
    });
  }
  if (!hit) return false;
  await client.query(SQL, [row.id, hit.template, JSON.stringify(hit.params ?? {})]);
  return true;
}
