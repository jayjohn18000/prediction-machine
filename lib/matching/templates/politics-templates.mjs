/**
 * Politics: topic key as template id (Phase E4).
 * Phase G Phase 2: per-candidate nominee pools add template_params.outcome_key so Kalshi/Polymarket
 * candidate legs do not collapse onto one canonical_market slot.
 */
import { extractTopicKey } from "../proposal-engine.mjs";
import {
  extractPoliticalOutcomeKey,
  shouldAttachPoliticalOutcomeKey,
} from "../political-outcome-key.mjs";

/**
 * @param {{ title?: string, provider_market_ref?: string, provider_id?: number, category?: string, metadata?: Record<string, unknown> }} market
 * @returns {{ template: string, params: Record<string, unknown> } | null}
 */
export function classifyTemplate(market) {
  const topicKey = extractTopicKey(market);
  if (!topicKey) return null;
  const combined = `${market?.title || ""} ${market?.provider_market_ref || ""}`.toLowerCase();
  const params = { topic_key: topicKey };
  if (shouldAttachPoliticalOutcomeKey(topicKey, combined)) {
    const outcomeKey = extractPoliticalOutcomeKey(market);
    if (outcomeKey) params.outcome_key = outcomeKey;
  }
  return {
    template: `politics-${String(topicKey).replace(/_/g, "-")}`,
    params,
  };
}
