/**
 * Politics: topic key as template id (Phase E4).
 */
import { extractTopicKey } from "../proposal-engine.mjs";

/**
 * @param {{ title?: string, provider_market_ref?: string, provider_id?: number, category?: string }} market
 * @returns {{ template: string, params: Record<string, unknown> } | null}
 */
export function classifyTemplate(market) {
  const topicKey = extractTopicKey(market);
  if (!topicKey) return null;
  return {
    template: `politics-${String(topicKey).replace(/_/g, "-")}`,
    params: { topic_key: topicKey },
  };
}
