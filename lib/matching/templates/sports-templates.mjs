/**
 * Sports: map market-type bucket to canonical template key (Phase E4).
 */
import { classifyMarketTypeBucket } from "../sports-helpers.mjs";

export { classifyMarketTypeBucket };

/**
 * @param {{ title?: string, provider_market_ref?: string, provider_id?: number, category?: string }} market
 * @returns {{ template: string, params: Record<string, unknown> } | null}
 */
export function classifyTemplate(market) {
  const bucket = classifyMarketTypeBucket(market?.title || "");
  if (!bucket) return null;
  return {
    template: `sports-${bucket.replace(/_/g, "-")}`,
    params: { bucket },
  };
}
