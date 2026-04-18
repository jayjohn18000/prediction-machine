/**
 * Sports: map market-type bucket to canonical template key (Phase E4).
 * Template names match lib/classification/vocabulary-market-template.mjs (sports-total, sports-yes-no, …).
 */
import { classifyMarketTypeBucket, SPORTS_BUCKET_TO_TEMPLATE } from "../sports-helpers.mjs";

export { classifyMarketTypeBucket };

/**
 * @param {{ title?: string, provider_market_ref?: string, provider_id?: number, category?: string }} market
 * @returns {{ template: string, params: Record<string, unknown> } | null}
 */
export function classifyTemplate(market) {
  const bucket = classifyMarketTypeBucket(market?.title || "");
  if (!bucket) return null;
  const template = SPORTS_BUCKET_TO_TEMPLATE[bucket];
  if (!template) return null;
  return {
    template,
    params: { bucket },
  };
}
