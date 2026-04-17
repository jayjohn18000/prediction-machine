/**
 * Route rule-based template classification by pmci category.
 */
import { classifyTemplate as classifyCrypto } from "./crypto-templates.mjs";
import { classifyTemplate as classifyEconomics } from "./economics-templates.mjs";
import { classifyTemplate as classifySports } from "./sports-templates.mjs";
import { classifyTemplate as classifyPolitics } from "./politics-templates.mjs";

/**
 * @param {{ title?: string, provider_market_ref?: string, provider_id?: number, category?: string }} market
 * @returns {{ template: string, params: Record<string, unknown> } | null}
 */
export function classifyTemplate(market) {
  const cat = String(market?.category || "").toLowerCase();
  if (cat === "crypto") return classifyCrypto(market);
  if (cat === "economics") return classifyEconomics(market);
  if (cat === "sports") return classifySports(market);
  if (cat === "politics") return classifyPolitics(market);
  return null;
}

export { classifyCrypto, classifyEconomics, classifySports, classifyPolitics };
