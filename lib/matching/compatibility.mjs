/**
 * Cross-cutting compatibility rules for proposer + observer frontier.
 * Sports market-type buckets live in sports-helpers; this module re-exports them
 * and centralizes relationship / category policy for DB queries.
 */

import { classifyMarketTypeBucket, looksLikeMatchupMarket } from "./sports-helpers.mjs";

export { classifyMarketTypeBucket, looksLikeMatchupMarket };

/** Default observer frontier: equivalent links only (safest bilateral spread). */
export const DEFAULT_OBSERVER_RELATIONSHIP_TYPES = ["equivalent"];

/**
 * Relationship types to include in observer frontier SQL (and proposer alignment).
 * OBSERVER_INCLUDE_PROXY_LINKS=1 adds `proxy` (still requires active links).
 */
export function getObserverRelationshipTypes() {
  const includeProxy =
    process.env.OBSERVER_INCLUDE_PROXY_LINKS === "1" ||
    process.env.OBSERVER_INCLUDE_PROXY_LINKS === "true";
  return includeProxy ? ["equivalent", "proxy"] : [...DEFAULT_OBSERVER_RELATIONSHIP_TYPES];
}

/** Comma-separated lowercased categories; null / empty = no filter (all categories). */
export function parseObserverCategoryAllowlist() {
  const raw = process.env.OBSERVER_CATEGORY_ALLOWLIST || "";
  const parts = raw
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return parts.length ? parts : null;
}

/**
 * Sports: same behavior as inline sports proposer — skip expensive scoring when both
 * buckets are known and differ.
 */
export function sportsMarketTypePairAllowed(kalshiTitle, polyTitle) {
  const k = classifyMarketTypeBucket(kalshiTitle);
  const p = classifyMarketTypeBucket(polyTitle);
  if (k && p && k !== p) return { ok: false, reason: `market_type_mismatch:${k}:${p}` };
  return { ok: true };
}

/** Max pairs from DB per observer cycle (cap). */
export function getObserverMaxPairsPerCycle() {
  const n = Number(process.env.OBSERVER_MAX_PAIRS_PER_CYCLE ?? "500");
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 50_000) : 500;
}

/** Rough asset bucket for crypto cross-venue prefilter (guard-first). */
export function cryptoAssetBucket(title) {
  const t = String(title || "").toLowerCase();
  if (/\b(btc|bitcoin)\b/.test(t)) return "btc";
  if (/\b(eth|ethereum)\b/.test(t)) return "eth";
  if (/\b(sol|solana)\b/.test(t)) return "sol";
  return null;
}

export function cryptoPairPrefilter(k, p) {
  const a = cryptoAssetBucket(`${k?.title || ""} ${k?.provider_market_ref || ""}`);
  const b = cryptoAssetBucket(`${p?.title || ""} ${p?.provider_market_ref || ""}`);
  if (!a || !b || a !== b) {
    return { ok: false, reason: `crypto_asset_mismatch:${a ?? "?"}:${b ?? "?"}` };
  }
  return { ok: true };
}
